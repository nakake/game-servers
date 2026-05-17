// AWS ラッパの公開窓口。
//
// Phase 1: SSM Run Command + EC2 RunInstances/DescribeInstances/TerminateInstances。
// EBS CreateSnapshot / DescribeSnapshots は後続で追加する。

export { AwsApiClient } from './client.js';
export type {
  AwsCredentials,
  AwsApiClientOptions,
  JsonRequestOptions,
  QueryRequestOptions,
} from './client.js';

export { AwsApiError, parseJsonError } from './errors.js';

export {
  sendShellCommand,
  getCommandInvocation,
  waitForCommand,
  isTerminalStatus,
} from './ssm.js';
export type {
  SendShellCommandInput,
  SendCommandOutput,
  GetCommandInvocationInput,
  CommandInvocation,
  CommandInvocationStatus,
  WaitForCommandOptions,
} from './ssm.js';

export {
  runInstances,
  describeInstances,
  describeInstancesByTag,
  terminateInstances,
  waitForInstanceRunning,
} from './ec2.js';
export type {
  RunInstancesInput,
  RunInstancesOutput,
  BlockDeviceMapping,
  InstanceDetail,
  InstanceState,
  TerminateInstanceResult,
  WaitForInstanceRunningOptions,
} from './ec2.js';

export {
  describeVolumesByTag,
  createSnapshot,
  describeSnapshotsByTag,
  getLatestCompletedSnapshot,
} from './ebs.js';
export type {
  VolumeDetail,
  VolumeAttachment,
  CreateSnapshotInput,
  SnapshotDetail,
} from './ebs.js';
