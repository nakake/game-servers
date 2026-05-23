// Discord embed の組み立て (Phase 4)。
//
// Worker 内部イベント (idle 停止 / snapshot 失敗 など) を Discord channel に投稿する
// ための embed object を純粋関数で組み立てる。実 fetch は `webhook.ts` の
// `postDiscordWebhookMessage` に渡す責務。
//
// 設計方針:
//   - severity (info / warning) のスキームは aws-notification.ts と揃える (color + icon)。
//   - 「次回 /start で再開できる」が伝わる文面を最優先 (友人内クローズド運用のため)。
//   - 内部 ID (instance / snapshot / volume) は補足行に小さく出す。

import type {
  StopTrigger,
  StopWorkflowOutcome,
} from '../../handlers/stop-workflow.js';
import type { GameDefinition } from '../registry/types.js';

// embed color (decimal、aws-notification.ts と整合させる)
const COLOR_INFO = 0x3498db;     // blue (idle stop 完了)
const COLOR_WARNING = 0xf39c12;  // orange (idle stop 失敗 / snapshot 失敗)

const TRIGGER_LABEL: Record<StopTrigger, string> = {
  discord: 'Discord /stop',
  sidecar: 'sidecar (idle 検知)',
  'cron-fallback': 'Cron フォールバック (sidecar 沈黙)',
};

// idle 停止 (sidecar / cron-fallback 発火) の通知 embed を組み立てる。
// 通知不要なケース (Discord 発火 / 通知価値の無い skip) は undefined を返し、呼び出し側で
// 投稿をスキップする。
//
// 返り値の embed 構造は Discord API の embed object そのまま (title / description / color /
// fields / footer)。
export function buildIdleStopNotification(
  game: GameDefinition,
  outcome: StopWorkflowOutcome,
  triggeredBy: StopTrigger,
): Record<string, unknown> | undefined {
  // Discord 経由の停止は元の /stop interaction が既に follow-up edit を出しているので
  // 二重通知を避けるためスキップ (呼び出し側でも triggeredBy ガードはしているが念のため二重に)。
  if (triggeredBy === 'discord') {
    return undefined;
  }

  // already-stopped は通知価値が低い (= 別経路で先に止まっただけ、ユーザーが知りたい情報無し)。
  // ノイズになるのでスキップする。
  if (outcome.status === 'already-stopped') {
    return undefined;
  }

  const trigger = TRIGGER_LABEL[triggeredBy];

  if (outcome.status === 'failed') {
    return {
      title: `⚠️ ${game.display_name} の自動停止に失敗しました`,
      description:
        `経路: ${trigger}\n` +
        `エラー: ${outcome.error.slice(0, 500)}\n\n` +
        `次回 /start で再開できますが、AWS コンソールで EC2 が残っていないか確認してください。`,
      color: COLOR_WARNING,
      timestamp: new Date().toISOString(),
      ...(outcome.instanceId !== undefined
        ? { footer: { text: `instance: ${outcome.instanceId}` } }
        : {}),
    };
  }

  // status === 'ok'
  const description = [`経路: ${trigger}`];
  if (outcome.snapshotId !== undefined) {
    description.push(`snapshot: \`${outcome.snapshotId}\` (次回 /start で使用)`);
  } else if (outcome.snapshotFailed === true) {
    description.push('⚠️ snapshot 作成に失敗しました (旧 volume は手動確認が必要)');
  }
  if (outcome.volumeId !== undefined && outcome.snapshotId !== undefined) {
    description.push(
      outcome.pendingCleanupScheduled
        ? `旧 volume \`${outcome.volumeId}\` は snapshot 完成後に自動削除されます`
        : `⚠️ 旧 volume \`${outcome.volumeId}\` の自動削除予約に失敗 (手動削除が必要)`,
    );
  }
  if (!outcome.dnsReset) {
    description.push('⚠️ DNS A レコードの placeholder 戻しに失敗 (次回 /start で上書きされます)');
  }

  return {
    title: `📴 ${game.display_name} を自動停止しました`,
    description: description.join('\n'),
    color: COLOR_INFO,
    timestamp: new Date().toISOString(),
    footer: { text: `instance: ${outcome.instanceId}` },
  };
}
