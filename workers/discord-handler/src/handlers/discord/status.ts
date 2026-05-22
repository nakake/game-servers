// /status — 現在 running な game サーバーの状態を即時 response で返す。
//
// Project=game-servers タグで running な全インスタンスを検索する (registry に依存しない)。
// AWS API を 1 回叩くので CPU 時間は短い (deferred 不要)。

import {
  AwsApiClient,
  describeInstancesByTag,
} from '../../lib/aws/index.js';
import { DiscordFollowUpClient } from '../../lib/discord/follow-up.js';
import {
  InteractionResponseType,
  type Interaction,
} from '../../lib/discord/types.js';
import type { Env } from '../../env.js';

export function handleStatusCommand(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Response {
  // Discord 3 秒制約があるので、AWS API 呼び出しが間に合う保証はない。
  // 念のため deferred response で返し、結果は follow-up で。
  ctx.waitUntil(executeStatus(interaction, env));
  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '🔍 状態を確認中…' },
  });
}

async function executeStatus(interaction: Interaction, env: Env): Promise<void> {
  const followUp = new DiscordFollowUpClient({
    applicationId: env.DISCORD_APPLICATION_ID,
    interactionToken: interaction.token,
  });

  const ec2 = new AwsApiClient({
    region: env.AWS_REGION ?? 'ap-northeast-1',
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  try {
    const running = await describeInstancesByTag(
      ec2,
      { Project: 'game-servers' },
      ['pending', 'running'],
    );
    if (running.length === 0) {
      await safeEdit(followUp, '💤 起動中の game サーバーはありません');
      return;
    }

    const lines = running.map((inst) => {
      const ip = inst.publicIp ?? '(no public IP yet)';
      return `- \`${inst.instanceId}\` — ${inst.state} — \`${ip}\``;
    });
    await safeEdit(followUp, `**Running game servers**\n${lines.join('\n')}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeEdit(followUp, `❌ status check failed: ${msg.slice(0, 500)}`);
  }
}

async function safeEdit(client: DiscordFollowUpClient, content: string): Promise<void> {
  try {
    await client.editOriginal(content);
  } catch (err) {
    console.error('Discord followUp editOriginal failed:', err);
  }
}
