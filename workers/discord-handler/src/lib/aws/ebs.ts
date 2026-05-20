// AWS EBS ラッパ (Query Protocol + XML)。
//
// Phase 1 hardcode で使う最小機能:
//   - describeVolumesByTag    : `/stop` で attached volume を identify する
//   - createSnapshot          : `/stop` で game-world volume の snapshot を取る (async fire-and-forget)
//   - describeSnapshotsByTag  : `/start` で latest completed snapshot を取得
//   - getLatestCompletedSnapshot : 上の薄いラッパ
//
// Snapshot は CreateSnapshot 直後に status=pending で返り、AWS 側で async に completed まで
// 進む。Worker からは完了を待たず terminate に進めて問題ない (次回 /start 時点で completed
// な最新を取り出す)。Worker の wall-clock 制限 (30s) を考えるとこの設計が現実的。

import { XMLParser } from 'fast-xml-parser';

import type { AwsApiClient } from './client.js';

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
  return items.map((v) => ({
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
  }));
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

// game-world データ volume の snapshot だけに付与するマーカー tag。
//
// RunInstances の TagSpecification(ResourceType=volume) は root volume にも tag を
// 伝播させるため、volume 由来の tag (Purpose=game-world 等) では「正しい game-world
// data volume の snapshot」と「root volume の snapshot (= 過去の /stop バグで混入した
// パーティション付き root クローン)」を区別できない。
//
// このマーカーは CreateSnapshot 時にのみ付与する snapshot 専用 tag。volume には
// 一切付かないので root クローンが誤って持つことはない。/start の復元 (getLatest-
// CompletedSnapshot) はこの tag を持つ snapshot だけを対象にする。
export const GAME_WORLD_SNAPSHOT_TAG_KEY = 'SnapshotType';
export const GAME_WORLD_SNAPSHOT_TAG_VALUE = 'game-world-data';

// startTime 降順で最新の completed snapshot を返す。なければ undefined。
//
// root volume クローンを誤って掴まないよう、game-world data マーカー tag
// (SnapshotType=game-world-data) を必須フィルタとして強制する。マーカー付き snapshot
// が 1 つも無ければ undefined を返し、呼び出し側 (start.ts) は env seed
// (ATM11_SNAPSHOT_ID) にフォールバックする。
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
