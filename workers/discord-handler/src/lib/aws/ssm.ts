// AWS Systems Manager (SSM) Run Command の薄いラッパ。
//
// 用途: Worker から EC2 上で `docker stop --time=60 mc` を発火する (ADR 0002)。
//
// 参考: https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_SendCommand.html

import type { AwsApiClient } from './client.js';
import { AwsApiError } from './errors.js';

export interface SendShellCommandInput {
  instanceIds: string[];
  // EC2 上で実行するシェルコマンド配列。1 行ずつ実行される。
  commands: string[];
  // コマンド全体の実行タイムアウト (秒)。デフォルト 60。
  timeoutSeconds?: number;
  // CloudWatch Logs にコマンド出力を流す場合のロググループ。省略可。
  cloudWatchLogGroupName?: string;
  comment?: string;
}

export interface SendCommandOutput {
  commandId: string;
  status: string;
  requestedDateTime: string;
}

export async function sendShellCommand(
  client: AwsApiClient,
  input: SendShellCommandInput,
): Promise<SendCommandOutput> {
  const payload: Record<string, unknown> = {
    InstanceIds: input.instanceIds,
    DocumentName: 'AWS-RunShellScript',
    Parameters: { commands: input.commands },
    TimeoutSeconds: input.timeoutSeconds ?? 60,
  };
  if (input.comment !== undefined) payload['Comment'] = input.comment;
  if (input.cloudWatchLogGroupName !== undefined) {
    payload['CloudWatchOutputConfig'] = {
      CloudWatchLogGroupName: input.cloudWatchLogGroupName,
      CloudWatchOutputEnabled: true,
    };
  }

  const response = await client.jsonRequest<{
    Command: {
      CommandId: string;
      Status: string;
      RequestedDateTime: number;
    };
  }>({
    service: 'ssm',
    target: 'AmazonSSM.SendCommand',
    payload,
  });

  return {
    commandId: response.Command.CommandId,
    status: response.Command.Status,
    // AWS は epoch seconds で返す。文字列化して扱いやすくする。
    requestedDateTime: new Date(response.Command.RequestedDateTime * 1000).toISOString(),
  };
}

export type CommandInvocationStatus =
  | 'Pending'
  | 'InProgress'
  | 'Delayed'
  | 'Success'
  | 'Cancelled'
  | 'TimedOut'
  | 'Failed'
  | 'Cancelling';

export interface GetCommandInvocationInput {
  commandId: string;
  instanceId: string;
}

export interface CommandInvocation {
  commandId: string;
  instanceId: string;
  status: CommandInvocationStatus;
  statusDetails: string;
  standardOutputContent: string;
  standardErrorContent: string;
  responseCode: number;
}

export async function getCommandInvocation(
  client: AwsApiClient,
  input: GetCommandInvocationInput,
): Promise<CommandInvocation> {
  const response = await client.jsonRequest<{
    CommandId: string;
    InstanceId: string;
    Status: CommandInvocationStatus;
    StatusDetails: string;
    StandardOutputContent: string;
    StandardErrorContent: string;
    ResponseCode: number;
  }>({
    service: 'ssm',
    target: 'AmazonSSM.GetCommandInvocation',
    payload: {
      CommandId: input.commandId,
      InstanceId: input.instanceId,
    },
  });

  return {
    commandId: response.CommandId,
    instanceId: response.InstanceId,
    status: response.Status,
    statusDetails: response.StatusDetails,
    standardOutputContent: response.StandardOutputContent,
    standardErrorContent: response.StandardErrorContent,
    responseCode: response.ResponseCode,
  };
}

// status が Terminal (これ以上変化しない) か判定。
export function isTerminalStatus(status: CommandInvocationStatus): boolean {
  return status === 'Success' || status === 'Cancelled' || status === 'TimedOut' || status === 'Failed';
}

// SendCommand → GetCommandInvocation を繰り返して終了を待つ便利関数。
// Workers 上で長時間 polling すると CPU 時間が嵩むので、間隔は呼び出し側で調整。
export interface WaitForCommandOptions {
  commandId: string;
  instanceId: string;
  // ポーリング間隔 (ms)。デフォルト 2000。
  pollIntervalMs?: number;
  // 全体タイムアウト (ms)。デフォルト 90_000 = 90 秒。
  timeoutMs?: number;
}

export async function waitForCommand(
  client: AwsApiClient,
  options: WaitForCommandOptions,
): Promise<CommandInvocation> {
  const interval = options.pollIntervalMs ?? 2000;
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);

  while (Date.now() < deadline) {
    try {
      const invocation = await getCommandInvocation(client, {
        commandId: options.commandId,
        instanceId: options.instanceId,
      });
      if (isTerminalStatus(invocation.status)) return invocation;
    } catch (err) {
      // SendCommand 直後は InvocationDoesNotExist が一瞬返ることがある。猶予を与える。
      if (err instanceof AwsApiError && err.awsErrorCode === 'InvocationDoesNotExist') {
        // fall through and sleep
      } else {
        throw err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `waitForCommand: timed out after ${options.timeoutMs ?? 90_000}ms (commandId=${options.commandId})`,
  );
}
