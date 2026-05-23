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

// Cron 失敗通知の文面に出る最大文字数 (Discord embed description は 4096 上限だが、
// stack trace まで貼ると読みづらい。先頭 300 chars で打ち切る、Phase 4 計画 Step 4)。
const ERROR_HEAD_MAX = 300;

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

// Cron 失敗通知 (snapshot-retention / volume-cleanup の Worker Cron が AWS API 失敗 or
// snapshot が "error" 状態だったケース)。Phase 4 Step 4 計画 §C 参照。
//
// 連投抑制は呼び出し側の `lib/state/notif-suppress.ts shouldNotify` で行う。本関数は embed
// 整形のみ (純粋関数なので unit test しやすい)。
export type CronFailureEventType = 'snapshot-retention' | 'volume-cleanup';

export interface CronFailureContext {
  eventType: CronFailureEventType;
  // 紐づくゲーム ID (snapshot-retention は必ず付く、volume-cleanup は volume の予約に紐づく場合のみ)。
  gameId?: string;
  // 失敗対象の AWS リソース ID (snap-... / vol-...)。アクション可能な情報なので必須。
  resourceId: string;
  // 'aws-error': DescribeSnapshots / DeleteSnapshot / DeleteVolume などの例外
  // 'snapshot-error-state': snapshot 自体が AWS 側で error state に落ちた (volume 削除を中止)
  reason: 'aws-error' | 'snapshot-error-state';
  // Error.message 等。先頭 ERROR_HEAD_MAX で truncate される。
  errorMessage: string;
}

export function buildCronFailureNotification(ctx: CronFailureContext): Record<string, unknown> {
  const titleByEvent: Record<CronFailureEventType, string> = {
    'snapshot-retention': '⚠️ snapshot 世代管理の Cron が失敗しました',
    'volume-cleanup': '⚠️ volume cleanup の Cron が失敗しました',
  };

  const lines: string[] = [];
  if (ctx.gameId !== undefined) {
    lines.push(`game: \`${ctx.gameId}\``);
  }
  lines.push(`resource: \`${ctx.resourceId}\``);

  if (ctx.reason === 'snapshot-error-state') {
    lines.push(
      'snapshot が AWS 側で **error state** に落ちました。' +
        '対応する volume は削除せず保持しています (手動で AWS コンソール確認が必要)。',
    );
  } else {
    lines.push('Cron 内の AWS API 呼び出しが例外で落ちました。次 tick で再試行されます。');
  }

  const errorHead =
    ctx.errorMessage.length > ERROR_HEAD_MAX
      ? `${ctx.errorMessage.slice(0, ERROR_HEAD_MAX)}\n…(truncated)`
      : ctx.errorMessage;
  lines.push('', '```', errorHead, '```');
  lines.push(
    '',
    '※ 1 時間に 1 回まで通知します (同じリソース ID の連投は抑制)。',
  );

  return {
    title: titleByEvent[ctx.eventType],
    description: lines.join('\n'),
    color: COLOR_WARNING,
    timestamp: new Date().toISOString(),
  };
}
