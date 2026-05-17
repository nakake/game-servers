// Phase 1 検証専用の admin endpoint。
//
// **削除予定** (Phase 2 で Discord 経由に置き換わったら不要)。
// 認証は Bearer token のみで弱いので、wrangler dev (localhost) でしか使わない前提。
// 本番デプロイで誤って公開しないよう、index.ts のルーティングで dev-only ガードを掛けている。

import {
  AwsApiClient,
  sendShellCommand,
  waitForCommand,
  type CommandInvocation,
} from '../lib/aws/index.js';
import type { Env } from '../env.js';

export async function handleAdminDockerStop(request: Request, env: Env): Promise<Response> {
  // 認証
  const auth = request.headers.get('authorization');
  if (!env.ADMIN_API_KEY || auth !== `Bearer ${env.ADMIN_API_KEY}`) {
    return new Response('Unauthorized\n', { status: 401 });
  }

  // body parse
  type Body = {
    instanceId?: string;
    containerName?: string;
    graceSeconds?: number;
  };
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body.instanceId !== 'string' || body.instanceId.length === 0) {
    return Response.json({ error: '"instanceId" is required' }, { status: 400 });
  }
  const containerName = body.containerName ?? 'atm11';
  const graceSeconds = body.graceSeconds ?? 60;

  const client = new AwsApiClient({
    region: env.AWS_REGION ?? 'ap-northeast-1',
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  try {
    const sent = await sendShellCommand(client, {
      instanceIds: [body.instanceId],
      // sudo は付けない: ec2-user が docker group に追加されている前提 (runbook-phase1.md)。
      // SSM agent は root で動くので sudo 無しでも実行可能だが、ssm-user 経由のケースに備えて
      // docker socket への権限が要らないよう、root として実行されることを利用する。
      commands: [`docker stop --time=${graceSeconds} ${containerName}`],
      timeoutSeconds: graceSeconds + 30,
      comment: `Phase 1 docker-stop test (${containerName})`,
    });

    let invocation: CommandInvocation;
    try {
      invocation = await waitForCommand(client, {
        commandId: sent.commandId,
        instanceId: body.instanceId,
        timeoutMs: (graceSeconds + 60) * 1000,
        pollIntervalMs: 2000,
      });
    } catch (err) {
      return Response.json(
        {
          phase: 'wait',
          commandId: sent.commandId,
          error: err instanceof Error ? err.message : String(err),
        },
        { status: 504 },
      );
    }

    return Response.json({
      commandId: sent.commandId,
      status: invocation.status,
      responseCode: invocation.responseCode,
      statusDetails: invocation.statusDetails,
      stdout: invocation.standardOutputContent,
      stderr: invocation.standardErrorContent,
    });
  } catch (err) {
    return Response.json(
      {
        phase: 'send',
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
