// /start <game> — Spot EC2 を起動し、DNS を更新し、Discord に完了通知。
//
// Discord 3 秒制約: deferred response (type 5) を即座に返し、重い処理は ctx.waitUntil 内で実行。
//
// Phase 1 hardcode: docker run の自動化は含まない (AMI に焼かれていないため)。
// 起動完了後ユーザーが SSH で `docker run` する経路を維持。完全自動化は Phase 4 で AMI 焼直し。

import { DiscordFollowUpClient } from '../../lib/discord/follow-up.js';
import {
  InteractionResponseType,
  type Interaction,
} from '../../lib/discord/types.js';
import { runStartWorkflow } from '../../lib/orchestrator/start.js';
import { getGame } from '../../lib/registry/store.js';
import type { GameDefinition } from '../../lib/registry/types.js';
import { storePendingReady } from '../../lib/state/pending-ready.js';
import type { Env } from '../../env.js';

export async function handleStartCommand(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const gameId = extractGameOption(interaction);
  const game = gameId !== undefined ? await getGame(env.GAME_REGISTRY, gameId) : undefined;
  if (game === undefined) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `❌ Unknown game: \`${gameId ?? '(missing)'}\`` },
    });
  }
  if (!game.enabled) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ゲーム \`${gameId}\` は無効化されています` },
    });
  }

  // 重い処理は waitUntil で後追い。Discord には先に deferred response を返す。
  ctx.waitUntil(executeStart(game, interaction, env, ctx));

  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `⏳ ${game.discord.start_message}` },
  });
}

function extractGameOption(interaction: Interaction): string | undefined {
  const option = interaction.data?.options?.find((o) => o.name === 'game');
  return typeof option?.value === 'string' ? option.value : undefined;
}

async function executeStart(
  game: GameDefinition,
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const followUp = new DiscordFollowUpClient({
    applicationId: env.DISCORD_APPLICATION_ID,
    interactionToken: interaction.token,
  });

  const gameId = game.game_id;

  // 起動の本体は Discord 非依存コアに委譲し (E-1)、進捗は follow-up edit に流す。
  // ここは Discord 固有の整形 (準備中メッセージ) と pending-ready 保存だけを担う。
  const result = await runStartWorkflow(env, ctx, game, {
    onProgress: (msg) => safeEdit(followUp, msg),
  });

  if (result.status === 'already-running') {
    await safeEdit(
      followUp,
      `⚠️ \`${gameId}\` は既に ${result.state} 状態です\n` +
        `instanceId: \`${result.instanceId}\`` +
        (result.publicIp !== undefined ? `\nIP: \`${result.publicIp}\`` : ''),
    );
    return;
  }
  if (result.status === 'failed') {
    await safeEdit(
      followUp,
      `❌ \`/start ${gameId}\` failed: ${result.error.slice(0, 500)}`,
    );
    return;
  }

  // status === 'started'。
  // この時点で完了しているのは「EC2 が running になり DNS が向いた」ところまで。
  // コンテナ起動 + MC のワールド読み込みはこの後 EC2 内で進む。よって「起動完了」では
  // なく「準備中」を表示し、本当に接続可能になったら ready 通知 (SNS) でこのメッセージを
  // ✅ に更新する。
  await safeEdit(
    followUp,
    `🟡 ${game.display_name} 起動準備中…\n` +
      `\`${result.fqdn}:${result.port}\` (IP: \`${result.publicIp}\`, instanceId: \`${result.instanceId}\`)\n` +
      `※ EC2 は稼働を開始しました。コンテナ起動と MC のワールド読み込みに数分かかります。\n` +
      `　接続できるようになったら、このメッセージを更新して @ でお知らせします。`,
  );

  // ready 通知 (SNS 経由) が後からこの元メッセージを ✅ に編集し、起動した人を mention
  // できるよう、interaction の文脈を KV に保存する。
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  await storePendingReady(env.SERVER_STATE, {
    applicationId: env.DISCORD_APPLICATION_ID,
    interactionToken: interaction.token,
    gameId,
    fqdn: result.fqdn,
    port: result.port,
    startedAt: new Date().toISOString(),
    ...(userId !== undefined ? { userId } : {}),
    ...(interaction.channel_id !== undefined
      ? { channelId: interaction.channel_id }
      : {}),
  }).catch((err) => console.error('storePendingReady failed:', err));
}

// follow-up が失敗しても処理を継続するためのラッパ。
async function safeEdit(client: DiscordFollowUpClient, content: string): Promise<void> {
  try {
    await client.editOriginal(content);
  } catch (err) {
    console.error('Discord followUp editOriginal failed:', err);
  }
}
