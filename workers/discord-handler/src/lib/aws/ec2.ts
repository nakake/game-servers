// AWS EC2 API ラッパ。EC2 は唯一 JSON protocol を持たない (Query Protocol + XML response) ので、
// AwsApiClient.queryRequest を使い、レスポンスは fast-xml-parser でパースする。
//
// Phase 1 hardcode `/start atm11` で使う最小機能:
//   - runInstances (Spot, instance market option 経由)
//   - describeInstances (Public IP 取得 polling 用)
//   - terminateInstances (停止用)
//   - waitForInstanceRunning (`pending` → `running` 待ち)
//
// Phase 2 で registry-driven `instance_types[]` を使うときに CreateFleet 化する。

import { XMLParser } from 'fast-xml-parser';

import type { AwsApiClient } from './client.js';

const EC2_API_VERSION = '2016-11-15';

// AWS Query Protocol の <item> タグは常に配列として扱う (1 件でも配列で返ってほしい)。
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (tagName) => tagName === 'item',
});

// ----------------------------------------------------------------------
// RunInstances
// ----------------------------------------------------------------------

export interface RunInstancesInput {
  // ami-xxx or `resolve:ssm:/aws/service/ami-amazon-linux-latest/...`
  imageId: string;
  instanceType: string;
  keyName?: string;
  securityGroupIds: string[];
  subnetId?: string;
  iamInstanceProfileName?: string;
  // user-data は呼び出し側で base64 エンコード済みの文字列を渡す。
  userData?: string;
  // Spot で起動するか。false / 省略時は on-demand。
  spot?: boolean;
  // spot 上限価格 (USD/h)。null 相当を渡したい時は空文字列ではなく省略する。
  spotMaxPriceUsd?: string;
  // instance リソースに付与するタグ。
  instanceTags?: Record<string, string>;
  // EBS ボリュームに付与するタグ。
  volumeTags?: Record<string, string>;
  blockDeviceMappings?: BlockDeviceMapping[];
}

export interface BlockDeviceMapping {
  deviceName: string;
  ebs?: {
    snapshotId?: string;
    volumeSize?: number;
    volumeType?: 'gp3' | 'gp2' | 'io2';
    deleteOnTermination?: boolean;
  };
}

export interface RunInstancesOutput {
  reservationId: string;
  instances: Array<{
    instanceId: string;
    state: string;
    privateIp?: string;
  }>;
}

function buildTagSpecificationParams(
  resourceType: 'instance' | 'volume',
  tags: Record<string, string>,
  index: number,
): Record<string, string> {
  const params: Record<string, string> = {
    [`TagSpecification.${index}.ResourceType`]: resourceType,
  };
  Object.entries(tags).forEach(([key, value], i) => {
    params[`TagSpecification.${index}.Tag.${i + 1}.Key`] = key;
    params[`TagSpecification.${index}.Tag.${i + 1}.Value`] = value;
  });
  return params;
}

function buildRunInstancesParams(input: RunInstancesInput): Record<string, string> {
  const params: Record<string, string> = {
    ImageId: input.imageId,
    MinCount: '1',
    MaxCount: '1',
    InstanceType: input.instanceType,
  };
  if (input.keyName !== undefined) params['KeyName'] = input.keyName;
  if (input.subnetId !== undefined) params['SubnetId'] = input.subnetId;
  if (input.iamInstanceProfileName !== undefined) {
    params['IamInstanceProfile.Name'] = input.iamInstanceProfileName;
  }
  if (input.userData !== undefined) params['UserData'] = input.userData;

  input.securityGroupIds.forEach((sg, i) => {
    params[`SecurityGroupId.${i + 1}`] = sg;
  });

  if (input.spot === true) {
    params['InstanceMarketOptions.MarketType'] = 'spot';
    params['InstanceMarketOptions.SpotOptions.SpotInstanceType'] = 'one-time';
    params['InstanceMarketOptions.SpotOptions.InstanceInterruptionBehavior'] = 'terminate';
    if (input.spotMaxPriceUsd !== undefined) {
      params['InstanceMarketOptions.SpotOptions.MaxPrice'] = input.spotMaxPriceUsd;
    }
  }

  let tagSpecIndex = 1;
  if (input.instanceTags !== undefined) {
    Object.assign(params, buildTagSpecificationParams('instance', input.instanceTags, tagSpecIndex));
    tagSpecIndex++;
  }
  if (input.volumeTags !== undefined) {
    Object.assign(params, buildTagSpecificationParams('volume', input.volumeTags, tagSpecIndex));
    tagSpecIndex++;
  }

  if (input.blockDeviceMappings !== undefined) {
    input.blockDeviceMappings.forEach((bdm, i) => {
      const prefix = `BlockDeviceMapping.${i + 1}`;
      params[`${prefix}.DeviceName`] = bdm.deviceName;
      const ebs = bdm.ebs;
      if (ebs !== undefined) {
        if (ebs.snapshotId !== undefined) params[`${prefix}.Ebs.SnapshotId`] = ebs.snapshotId;
        if (ebs.volumeSize !== undefined) params[`${prefix}.Ebs.VolumeSize`] = String(ebs.volumeSize);
        if (ebs.volumeType !== undefined) params[`${prefix}.Ebs.VolumeType`] = ebs.volumeType;
        if (ebs.deleteOnTermination !== undefined) {
          params[`${prefix}.Ebs.DeleteOnTermination`] = String(ebs.deleteOnTermination);
        }
      }
    });
  }

  return params;
}

interface RawInstanceItem {
  instanceId: string;
  instanceState: { name: string };
  privateIpAddress?: string;
  ipAddress?: string;
  dnsName?: string;
}

interface RawDescribeReservation {
  instancesSet?: { item?: RawInstanceItem[] };
}

interface RawRunInstancesResponse {
  RunInstancesResponse: {
    reservationId: string;
    instancesSet?: { item?: RawInstanceItem[] };
  };
}

interface RawDescribeInstancesResponse {
  DescribeInstancesResponse: {
    reservationSet?: { item?: RawDescribeReservation[] };
  };
}

interface RawTerminateInstancesResponse {
  TerminateInstancesResponse: {
    instancesSet?: {
      item?: Array<{
        instanceId: string;
        currentState: { name: string };
        previousState: { name: string };
      }>;
    };
  };
}

export async function runInstances(
  client: AwsApiClient,
  input: RunInstancesInput,
): Promise<RunInstancesOutput> {
  const xml = await client.queryRequest({
    service: 'ec2',
    action: 'RunInstances',
    version: EC2_API_VERSION,
    params: buildRunInstancesParams(input),
  });

  const parsed = xmlParser.parse(xml) as RawRunInstancesResponse;
  const root = parsed.RunInstancesResponse;
  const items = root.instancesSet?.item ?? [];

  return {
    reservationId: root.reservationId,
    instances: items.map((inst) => ({
      instanceId: inst.instanceId,
      state: inst.instanceState.name,
      ...(inst.privateIpAddress !== undefined ? { privateIp: inst.privateIpAddress } : {}),
    })),
  };
}

// ----------------------------------------------------------------------
// DescribeInstances
// ----------------------------------------------------------------------

export type InstanceState =
  | 'pending'
  | 'running'
  | 'shutting-down'
  | 'terminated'
  | 'stopping'
  | 'stopped';

export interface InstanceDetail {
  instanceId: string;
  state: InstanceState;
  publicIp?: string;
  publicDnsName?: string;
  privateIp?: string;
}

export async function describeInstances(
  client: AwsApiClient,
  instanceIds: string[],
): Promise<InstanceDetail[]> {
  const params: Record<string, string> = {};
  instanceIds.forEach((id, i) => {
    params[`InstanceId.${i + 1}`] = id;
  });
  return describeInstancesRaw(client, params);
}

// タグ + 状態フィルタで検索する。Phase 1 hardcode の重複起動チェック / `/stop` の自動検索で使う。
//   例: describeInstancesByTag(client, { Game: 'atm11' }, ['pending', 'running'])
export async function describeInstancesByTag(
  client: AwsApiClient,
  tags: Record<string, string>,
  states: InstanceState[] = ['pending', 'running'],
): Promise<InstanceDetail[]> {
  const params: Record<string, string> = {};
  let filterIndex = 1;
  for (const [key, value] of Object.entries(tags)) {
    params[`Filter.${filterIndex}.Name`] = `tag:${key}`;
    params[`Filter.${filterIndex}.Value.1`] = value;
    filterIndex++;
  }
  if (states.length > 0) {
    params[`Filter.${filterIndex}.Name`] = 'instance-state-name';
    states.forEach((s, i) => {
      params[`Filter.${filterIndex}.Value.${i + 1}`] = s;
    });
  }
  return describeInstancesRaw(client, params);
}

async function describeInstancesRaw(
  client: AwsApiClient,
  params: Record<string, string>,
): Promise<InstanceDetail[]> {
  const xml = await client.queryRequest({
    service: 'ec2',
    action: 'DescribeInstances',
    version: EC2_API_VERSION,
    params,
  });

  const parsed = xmlParser.parse(xml) as RawDescribeInstancesResponse;
  const reservations = parsed.DescribeInstancesResponse.reservationSet?.item ?? [];

  const instances: InstanceDetail[] = [];
  for (const reservation of reservations) {
    for (const inst of reservation.instancesSet?.item ?? []) {
      instances.push({
        instanceId: inst.instanceId,
        state: inst.instanceState.name as InstanceState,
        ...(inst.ipAddress !== undefined && inst.ipAddress !== ''
          ? { publicIp: inst.ipAddress }
          : {}),
        ...(inst.dnsName !== undefined && inst.dnsName !== ''
          ? { publicDnsName: inst.dnsName }
          : {}),
        ...(inst.privateIpAddress !== undefined ? { privateIp: inst.privateIpAddress } : {}),
      });
    }
  }
  return instances;
}

// ----------------------------------------------------------------------
// TerminateInstances
// ----------------------------------------------------------------------

export interface TerminateInstanceResult {
  instanceId: string;
  currentState: string;
  previousState: string;
}

export async function terminateInstances(
  client: AwsApiClient,
  instanceIds: string[],
): Promise<TerminateInstanceResult[]> {
  const params: Record<string, string> = {};
  instanceIds.forEach((id, i) => {
    params[`InstanceId.${i + 1}`] = id;
  });

  const xml = await client.queryRequest({
    service: 'ec2',
    action: 'TerminateInstances',
    version: EC2_API_VERSION,
    params,
  });

  const parsed = xmlParser.parse(xml) as RawTerminateInstancesResponse;
  return (parsed.TerminateInstancesResponse.instancesSet?.item ?? []).map((inst) => ({
    instanceId: inst.instanceId,
    currentState: inst.currentState.name,
    previousState: inst.previousState.name,
  }));
}

// ----------------------------------------------------------------------
// waitForInstanceRunning
// ----------------------------------------------------------------------

export interface WaitForInstanceRunningOptions {
  instanceId: string;
  // ポーリング間隔 (ms)。デフォルト 3000。
  pollIntervalMs?: number;
  // 全体タイムアウト (ms)。デフォルト 180_000 = 3 分。
  timeoutMs?: number;
}

// state=running + public IP 取得まで待つ。terminal state (terminated/stopped/...) に
// 落ちた場合は throw する。
export async function waitForInstanceRunning(
  client: AwsApiClient,
  options: WaitForInstanceRunningOptions,
): Promise<InstanceDetail> {
  const interval = options.pollIntervalMs ?? 3000;
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);

  while (Date.now() < deadline) {
    const [inst] = await describeInstances(client, [options.instanceId]);
    if (inst === undefined) {
      // 直後はまだ ec2 が見えないことがある。猶予を与える。
    } else if (inst.state === 'running' && inst.publicIp !== undefined) {
      return inst;
    } else if (
      inst.state === 'terminated' ||
      inst.state === 'shutting-down' ||
      inst.state === 'stopped' ||
      inst.state === 'stopping'
    ) {
      throw new Error(
        `waitForInstanceRunning: instance entered terminal state "${inst.state}" (instanceId=${options.instanceId})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(
    `waitForInstanceRunning: timed out after ${options.timeoutMs ?? 180_000}ms (instanceId=${options.instanceId})`,
  );
}
