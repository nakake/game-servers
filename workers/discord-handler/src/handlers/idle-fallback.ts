// Cron フォールバック — sidecar が沈黙したゲームを Worker から強制停止する保険 (Phase 3 Step 3)。
//
// 既存 5 分 cron の追加処理。docs/phase3-plan.md 決定6 / Step 3 参照。
//
// 流れ:
//   1. listGames で enabled な game を全件取得
//   2. 各 game について `last-seen:<game_id>` を読む
//   3. decideIdleAction で「stop すべきか」を純粋関数として判定
//   4. stop action なら runStopWorkflow を呼ぶ (expectedInstanceId は last_seen の instance を渡し、
//      新 instance に置き換わっていれば runStopWorkflow 側で instance-mismatch スキップ)
//
// last_seen キーが無いゲームは「sidecar が一度も heartbeat してこなかった」状態とみなして
// 何もしない。/start 直後の grace (sidecar 起動待ち) や、heartbeat の KV TTL 切れ後の異常状態
// での誤停止を避ける。本当に停止が必要なケースは Discord `/stop` か Spot 中断に任せる。

import { listGames } from '../lib/registry/store.js';
import { getLastSeen, type SidecarLastSeen } from '../lib/state/last-seen.js';
import type { GameDefinition } from '../lib/registry/types.js';
import { runStopWorkflow } from './stop-workflow.js';
import type { Env } from '../env.js';

// 閾値: `timeout_min` の経過は sidecar 側で判定してくれる前提だが、sidecar 自体が落ちて
// 通信できないケースを拾うため Worker 側でさらに 5 分の skew を持たせる (heartbeat の TTL は
// timeout_min * 3 で持っているので、5 分追加でも余裕は残る)。
const FALLBACK_SKEW_MIN = 5;

export type IdleDecision =
  | { action: 'stop'; expectedInstanceId: string; elapsedMs: number; thresholdMs: number }
  | { action: 'skip'; reason: 'no-heartbeat' | 'within-window' | 'invalid-data' };

export function decideIdleAction(
  game: GameDefinition,
  lastSeen: SidecarLastSeen | undefined,
  now: number,
): IdleDecision {
  if (lastSeen === undefined) {
    return { action: 'skip', reason: 'no-heartbeat' };
  }

  const lastSeenMs = Date.parse(lastSeen.lastSeenAt);
  if (Number.isNaN(lastSeenMs)) {
    return { action: 'skip', reason: 'invalid-data' };
  }

  const elapsedMs = now - lastSeenMs;
  const thresholdMs = (game.idle_check.timeout_min + FALLBACK_SKEW_MIN) * 60_000;
  if (elapsedMs <= thresholdMs) {
    return { action: 'skip', reason: 'within-window' };
  }

  return {
    action: 'stop',
    expectedInstanceId: lastSeen.instanceId,
    elapsedMs,
    thresholdMs,
  };
}

export interface IdleFallbackOutcome {
  gameId: string;
  decision: IdleDecision;
  // stop を実行した場合のみ stopOutcome を持つ。
  stopOutcome?: unknown;
}

export async function handleIdleFallback(
  env: Env,
  ctx: ExecutionContext,
): Promise<IdleFallbackOutcome[]> {
  const now = Date.now();
  const games = await listGames(env.GAME_REGISTRY);
  const outcomes: IdleFallbackOutcome[] = [];

  for (const game of games) {
    if (!game.enabled) continue;

    const lastSeen = await getLastSeen(env.SERVER_STATE, game.game_id);
    const decision = decideIdleAction(game, lastSeen, now);

    if (decision.action === 'skip') {
      // skip はノイズが多いので reason: 'no-heartbeat' は debug、それ以外は info でログ。
      if (decision.reason !== 'no-heartbeat') {
        console.log(
          `[idle-fallback] ${game.game_id} skip (${decision.reason})`,
        );
      }
      outcomes.push({ gameId: game.game_id, decision });
      continue;
    }

    console.warn(
      `[idle-fallback] ${game.game_id} silent for ${Math.round(decision.elapsedMs / 60_000)} min ` +
        `(threshold ${Math.round(decision.thresholdMs / 60_000)} min). forcing stop.`,
    );
    const stopOutcome = await runStopWorkflow(env, ctx, game, {
      triggeredBy: 'cron-fallback',
      expectedInstanceId: decision.expectedInstanceId,
    });
    console.log(
      `[idle-fallback] ${game.game_id} stop outcome:`,
      JSON.stringify(stopOutcome),
    );
    outcomes.push({ gameId: game.game_id, decision, stopOutcome });
  }

  return outcomes;
}
