// /stop — 起動中の game サーバーを graceful 停止する Discord ハンドラ。
//
// Phase 3 でメインロジックを handlers/stop-workflow.ts に切り出し、ここは Discord 応答整形
// だけを担う薄いラッパになった。同じ workflow は sidecar `/sidecar/idle-detected` (Step 2)
// と Cron フォールバック (Step 3) からも呼ばれる。

import { DiscordFollowUpClient } from '../../lib/discord/follow-up.js';
import {
  InteractionResponseType,
  type Interaction,
} from '../../lib/discord/types.js';
import { getGame } from '../../lib/registry/store.js';
import type { GameDefinition } from '../../lib/registry/types.js';
import { runStopWorkflow, type StopWorkflowOutcome } from '../stop-workflow.js';
import type { Env } from '../../env.js';

export async function handleStopCommand(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const gameId = extractGameOption(interaction);
  if (gameId === undefined) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❌ 停止するゲームを指定してください' },
    });
  }
  const game = await getGame(env.GAME_REGISTRY, gameId);
  if (game === undefined) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `❌ Unknown game: \`${gameId}\`` },
    });
  }

  ctx.waitUntil(executeStop(game, interaction, env, ctx));

  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `⏳ ${gameId} を停止中…` },
  });
}

function extractGameOption(interaction: Interaction): string | undefined {
  const option = interaction.data?.options?.find((o) => o.name === 'game');
  return typeof option?.value === 'string' ? option.value : undefined;
}

async function executeStop(
  game: GameDefinition,
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const followUp = new DiscordFollowUpClient({
    applicationId: env.DISCORD_APPLICATION_ID,
    interactionToken: interaction.token,
  });

  const outcome = await runStopWorkflow(env, ctx, game, {
    triggeredBy: 'discord',
    onProgress: (msg) => safeEdit(followUp, msg),
  });

  await safeEdit(followUp, renderOutcome(game, outcome));
}

function renderOutcome(game: GameDefinition, outcome: StopWorkflowOutcome): string {
  const gameId = game.game_id;
  switch (outcome.status) {
    case 'ok': {
      const snapshotNote =
        outcome.snapshotId !== undefined
          ? `\nsnapshot: \`${outcome.snapshotId}\` (次回 /start で使用)`
          : '';
      let volumeNote = '';
      if (outcome.snapshotId !== undefined && outcome.volumeId !== undefined) {
        volumeNote = outcome.pendingCleanupScheduled
          ? `\n旧 volume \`${outcome.volumeId}\` は snapshot 完成後に自動削除されます`
          : `\n⚠️ 旧 volume \`${outcome.volumeId}\` の自動削除予約に失敗しました (手動削除が必要)`;
      }
      return `✅ ${game.discord.stop_message}${snapshotNote}${volumeNote}`;
    }
    case 'already-stopped':
      switch (outcome.reason) {
        case 'no-instance':
          return `ℹ️ \`${gameId}\` は既に停止しています`;
        case 'in-progress':
          return `ℹ️ \`${gameId}\` は別経路で停止処理中です (重複発火を回避)`;
        case 'instance-mismatch':
          return (
            `ℹ️ \`${gameId}\` は別の instance に置き換わっています ` +
            `(current=${outcome.currentInstanceId ?? 'unknown'})`
          );
      }
    /* eslint-disable-next-line no-fallthrough */
    case 'failed':
      return `❌ \`/stop ${gameId}\` failed: ${outcome.error.slice(0, 500)}`;
  }
}

async function safeEdit(client: DiscordFollowUpClient, content: string): Promise<void> {
  try {
    await client.editOriginal(content);
  } catch (err) {
    console.error('Discord followUp editOriginal failed:', err);
  }
}
