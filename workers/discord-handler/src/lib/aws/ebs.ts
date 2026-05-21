// AWS EBS ラッパ (Query Protocol + XML)。
//
// 機能:
//   - describeVolumesByTag      : `/stop` で attached volume を identify する
//   - describeVolumeById        : volume を id 指定で 1 件取得
//   - createSnapshot            : `/stop` で game-world volume の snapshot を取る
//   - deleteVolume              : `/stop` で snapshot 完成後に旧 data volume を削除する
//   - describeSnapshotsByTag    : tag で snapshot を検索
//   - describeSnapshotById      : snapshot を id 指定で 1 件取得
//   - getLatestCompletedSnapshot: 最新の completed snapshot を取得 (フォールバック用)
//   - getLatestSnapshot         : 最新の snapshot を state 問わず取得 (`/start` の主経路)
//   - waitForSnapshotCompleted  : snapshot が completed になるまで polling
//
// Snapshot は CreateSnapshot 直後に status=pending で返り、AWS 側で async に completed まで
// 進む。完成まで数分かかり Worker の 1 invocation では待ち切れないため、`/stop` は volume の
// 削除を Cron (handlers/cleanup.ts) に委譲する。Cron は describeSnapshotById で completed を
// 確認してから deleteVolume する。`/start` 側は、まだ completed になっていない最新 snapshot を
// 掴んだ場合に限り短時間 waitForSnapshotCompleted する (一つ前への巻き戻しを防ぐ)。

import { XMLParser } from 'fast-xml-parser';

import type { AwsApiClient } from './client.js';
import { AwsApiError } from './errors.js';

const EC2_API_VERSION = '2016-11-15';

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (tagName) => tagName === 'item',
});

// ----------------------------------------------------------------------
// Tag helpers
// ----------------------------------------------------------------------

interface RawTagItem {
  key: string;
  value: string;
}

function tagsToMap(items: RawTagItem[] | undefined): Record<string, string> {
  if (items === undefined) return {};
  const out: Record<string, string> = {};
  for (const t of items) {
    out[t.key] = t.value;
  }
  return out;
}

function buildTagFilters(
  tags: Record<string, string>,
  startIndex: number,
): { params: Record<string, string>; nextIndex: number } {
  const params: Record<string, string> = {};
  let index = startIndex;
  for (const [key, value] of Object.entries(tags)) {
    params[`Filter.${index}.Name`] = `tag:${key}`;
    params[`Filter.${index}.Value.1`] = value;
    index++;
  }
  return { params, nextIndex: index };
}

// ----------------------------------------------------------------------
// DescribeVolumes
// ----------------------------------------------------------------------

export interface VolumeAttachment {
  instanceId: string;
  device: string;
  state: string;
  deleteOnTermination: boolean;
}

export interface VolumeDetail {
  volumeId: string;
  state: 'creating' | 'available' | 'in-use' | 'deleting' | 'deleted' | 'error';
  size: number;
  snapshotId?: string;
  availabilityZone: string;
  attachments: VolumeAttachment[];
  tags: Record<string, string>;
}

interface RawVolumeItem {
  volumeId: string;
  status: VolumeDetail['state'];
  size: string;
  snapshotId?: string;
  availabilityZone: string;
  attachmentSet?: {
    item?: Array<{
      instanceId: string;
      device: string;
      status: string;
      deleteOnTermination: string;
    }>;
  };
  tagSet?: { item?: RawTagItem[] };
}

interface RawDescribeVolumesResponse {
  DescribeVolumesResponse: {
    volumeSet?: { item?: RawVolumeItem[] };
  };
}

function rawVolumeToDetail(v: RawVolumeItem): VolumeDetail {
  return {
    volumeId: v.volumeId,
    state: v.status,
    size: parseInt(v.size, 10),
    ...(v.snapshotId !== undefined && v.snapshotId !== '' ? { snapshotId: v.snapshotId } : {}),
    availabilityZone: v.availabilityZone,
    attachments: (v.attachmentSet?.item ?? []).map((a) => ({
      instanceId: a.instanceId,
      device: a.device,
      state: a.status,
      deleteOnTermination: a.deleteOnTermination === 'true',
    })),
    tags: tagsToMap(v.tagSet?.item),
  };
}

export async function describeVolumesByTag(
  client: AwsApiClient,
  tags: Record<string, string>,
  states?: VolumeDetail['state'][],
): Promise<VolumeDetail[]> {
  const filters = buildTagFilters(tags, 1);
  const params = filters.params;
  let nextIndex = filters.nextIndex;
  if (states !== undefined && states.length > 0) {
    params[`Filter.${nextIndex}.Name`] = 'status';
    states.forEach((s, i) => {
      params[`Filter.${nextIndex}.Value.${i + 1}`] = s;
    });
    nextIndex++;
  }

  const xml = await client.queryRequest({
    service: 'ec2',
    action: 'DescribeVolumes',
    version: EC2_API_VERSION,
    params,
  });

  const parsed = xmlParser.parse(xml) as RawDescribeVolumesResponse;
  const items = parsed.DescribeVolumesResponse.volumeSet?.item ?? [];
  return items.map(rawVolumeToDetail);
}

// volume を id 指定で 1 件取得する。存在しなければ undefined。
export async function describeVolumeById(
  client: AwsApiClient,
  volumeId: string,
): Promise<VolumeDetail | undefined> {
  const xml = await client.queryRequest({
    service: 'ec2',
    action: 'DescribeVolumes',
    version: EC2_API_VERSION,
    params: { 'VolumeId.1': volumeId },
  });
  const parsed = xmlParser.parse(xml) as RawDescribeVolumesResponse;
  const item = (parsed.DescribeVolumesResponse.volumeSet?.item ?? [])[0];
  return item !== undefined ? rawVolumeToDetail(item) : undefined;
}

// volume を削除する。`/stop` が snapshot 完成を確認した後、課金されつづける旧 data volume
// を消すのに使う。DeleteVolume のレスポンスは <return>true</return> だけなのでパース不要。
export async function deleteVolume(client: AwsApiClient, volumeId: string): Promise<void> {
  await client.queryRequest({
    service: 'ec2',
    action: 'DeleteVolume',
    version: EC2_API_VERSION,
    params: { VolumeId: volumeId },
  });
}

// ----------------------------------------------------------------------
// CreateSnapshot
// ----------------------------------------------------------------------

export interface CreateSnapshotInput {
  volumeId: string;
  description?: string;
  tags?: Record<string, string>;
}

export interface SnapshotDetail {
  snapshotId: string;
  state: 'pending' | 'completed' | 'error' | 'recoverable' | 'recovering';
  progress: string;
  startTime: string;
  volumeId: string;
  volumeSize: number;
  description?: string;
  tags: Record<string, string>;
}

interface RawSnapshotItem {
  snapshotId: string;
  status: SnapshotDetail['state'];
  progress: string;
  startTime: string;
  volumeId: string;
  volumeSize: string;
  description?: string;
  tagSet?: { item?: RawTagItem[] };
}

interface RawCreateSnapshotResponse {
  CreateSnapshotResponse: RawSnapshotItem;
}

interface RawDescribeSnapshotsResponse {
  DescribeSnapshotsResponse: {
    snapshotSet?: { item?: RawSnapshotItem[] };
  };
}

function rawSnapshotToDetail(raw: RawSnapshotItem): SnapshotDetail {
  return {
    snapshotId: raw.snapshotId,
    state: raw.status,
    progress: raw.progress,
    startTime: raw.startTime,
    volumeId: raw.volumeId,
    volumeSize: parseInt(raw.volumeSize, 10),
    ...(raw.description !== undefined && raw.description !== ''
      ? { description: raw.description }
      : {}),
    tags: tagsToMap(raw.tagSet?.item),
  };
}

export async function createSnapshot(
  client: AwsApiClient,
  input: CreateSnapshotInput,
): Promise<SnapshotDetail> {
  const params: Record<string, string> = {
    VolumeId: input.volumeId,
  };
  if (input.description !== undefined) params['Description'] = input.description;

  if (input.tags !== undefined) {
    params['TagSpecification.1.ResourceType'] = 'snapshot';
    Object.entries(input.tags).forEach(([key, value], i) => {
      params[`TagSpecification.1.Tag.${i + 1}.Key`] = key;
      params[`TagSpecification.1.Tag.${i + 1}.Value`] = value;
    });
  }

  const xml = await client.queryRequest({
    service: 'ec2',
    action: 'CreateSnapshot',
    version: EC2_API_VERSION,
    params,
  });

  const parsed = xmlParser.parse(xml) as RawCreateSnapshotResponse;
  return rawSnapshotToDetail(parsed.CreateSnapshotResponse);
}

// ----------------------------------------------------------------------
// DescribeSnapshots
// ----------------------------------------------------------------------

export async function describeSnapshotsByTag(
  client: AwsApiClient,
  tags: Record<string, string>,
  states?: SnapshotDetail['state'][],
): Promise<SnapshotDetail[]> {
  const filters = buildTagFilters(tags, 1);
  const params = filters.params;
  let nextIndex = filters.nextIndex;
  if (states !== undefined && states.length > 0) {
    params[`Filter.${nextIndex}.Name`] = 'status';
    states.forEach((s, i) => {
      params[`Filter.${nextIndex}.Value.${i + 1}`] = s;
    });
    nextIndex++;
  }
  // Owner=self を必須に (他人 snapshot を見ない)
  params['Owner.1'] = 'self';

  const xml = await client.queryRequest({
    service: 'ec2',
    action: 'DescribeSnapshots',
    version: EC2_API_VERSION,
    params,
  });

  const parsed = xmlParser.parse(xml) as RawDescribeSnapshotsResponse;
  const items = parsed.DescribeSnapshotsResponse.snapshotSet?.item ?? [];
  return items.map(rawSnapshotToDetail);
}

// snapshot を id 指定で 1 件取得する。存在しなければ undefined。
// waitForSnapshotCompleted の polling 用。
export async function describeSnapshotById(
  client: AwsApiClient,
  snapshotId: string,
): Promise<SnapshotDetail | undefined> {
  const xml = await client.queryRequest({
    service: 'ec2',
    action: 'DescribeSnapshots',
    version: EC2_API_VERSION,
    params: { 'SnapshotId.1': snapshotId },
  });
  const parsed = xmlParser.parse(xml) as RawDescribeSnapshotsResponse;
  const item = (parsed.DescribeSnapshotsResponse.snapshotSet?.item ?? [])[0];
  return item !== undefined ? rawSnapshotToDetail(item) : undefined;
}

// game-world データ volume の snapshot だけに付与するマーカー tag。
//
// RunInstances の TagSpecification(ResourceType=volume) は root volume にも tag を
// 伝播させるため、volume 由来の tag (Purpose=game-world 等) では「正しい game-world
// data volume の snapshot」と「root volume の snapshot (= 過去の /stop バグで混入した
// パーティション付き root クローン)」を区別できない。
//
// このマーカーは CreateSnapshot 時にのみ付与する snapshot 専用 tag。volume には
// 一切付かないので root クローンが誤って持つことはない。/start の復元 (getLatest-
// Snapshot / getLatestCompletedSnapshot) はこの tag を持つ snapshot だけを対象にする。
export const GAME_WORLD_SNAPSHOT_TAG_KEY = 'SnapshotType';
export const GAME_WORLD_SNAPSHOT_TAG_VALUE = 'game-world-data';

// startTime 降順で最新の completed snapshot を返す。なければ undefined。
//
// root volume クローンを誤って掴まないよう、game-world data マーカー tag
// (SnapshotType=game-world-data) を必須フィルタとして強制する。`/start` で最新 snapshot が
// pending / error 等のときのフォールバック先として使う。
export async function getLatestCompletedSnapshot(
  client: AwsApiClient,
  tags: Record<string, string>,
): Promise<SnapshotDetail | undefined> {
  const filterTags = {
    ...tags,
    [GAME_WORLD_SNAPSHOT_TAG_KEY]: GAME_WORLD_SNAPSHOT_TAG_VALUE,
  };
  const all = await describeSnapshotsByTag(client, filterTags, ['completed']);
  if (all.length === 0) return undefined;
  // startTime は ISO8601、文字列比較で正しい順序になる
  all.sort((a, b) => (a.startTime < b.startTime ? 1 : -1));
  return all[0];
}

// startTime 降順で最新の snapshot を state 問わず返す。なければ undefined。
//
// `/start` の復元元決定の主経路。getLatestCompletedSnapshot と同じく game-world data
// マーカー tag を必須にするが、状態フィルタを掛けないので pending の snapshot も対象に
// なる。呼び出し側 (start.ts) は返ってきた state を見て completed ならそのまま使用、
// pending なら waitForSnapshotCompleted、それ以外なら getLatestCompletedSnapshot に
// フォールバックする。
export async function getLatestSnapshot(
  client: AwsApiClient,
  tags: Record<string, string>,
): Promise<SnapshotDetail | undefined> {
  const filterTags = {
    ...tags,
    [GAME_WORLD_SNAPSHOT_TAG_KEY]: GAME_WORLD_SNAPSHOT_TAG_VALUE,
  };
  const all = await describeSnapshotsByTag(client, filterTags);
  if (all.length === 0) return undefined;
  all.sort((a, b) => (a.startTime < b.startTime ? 1 : -1));
  return all[0];
}

// ----------------------------------------------------------------------
// waitForSnapshotCompleted
// ----------------------------------------------------------------------

export interface WaitForSnapshotCompletedOptions {
  snapshotId: string;
  // ポーリング間隔 (ms)。デフォルト 5000。
  pollIntervalMs?: number;
  // 全体タイムアウト (ms)。デフォルト 300_000 = 5 分。
  timeoutMs?: number;
}

// snapshot が state=completed になるまで待つ。error state に落ちたら throw、timeout でも throw。
export async function waitForSnapshotCompleted(
  client: AwsApiClient,
  options: WaitForSnapshotCompletedOptions,
): Promise<SnapshotDetail> {
  const interval = options.pollIntervalMs ?? 5000;
  const timeout = options.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    let snap: SnapshotDetail | undefined;
    try {
      snap = await describeSnapshotById(client, options.snapshotId);
    } catch (err) {
      // CreateSnapshot 直後は eventual consistency で InvalidSnapshot.NotFound が
      // 返ることがある。terminal error ではないので polling を継続する。
      if (!(err instanceof AwsApiError && err.awsErrorCode === 'InvalidSnapshot.NotFound')) {
        throw err;
      }
    }
    if (snap !== undefined) {
      if (snap.state === 'completed') return snap;
      if (snap.state === 'error') {
        throw new Error(
          `waitForSnapshotCompleted: snapshot entered "error" state (snapshotId=${options.snapshotId})`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(
    `waitForSnapshotCompleted: timed out after ${timeout}ms (snapshotId=${options.snapshotId})`,
  );
}
