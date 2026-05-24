// POST /sidecar/idle-detected — sidecar が「`timeout_min` 経過しても player 0 だった」と
// 判定したときに通知してくる。Worker は HMAC 検証だけ同期で行い、stop ワークフローは
// ctx.waitUntil で非同期に走らせて即時 202 を返す (sidecar 側 HTTP timeout 回避)。
//
// expectedInstanceId を runStopWorkflow に渡し、現在 running の instance と一致しない場合は
// 古い instance からの晩到通知として無視する (新 instance が既に上がっている可能性、
// docs/phase3-plan.md 決定7 参照)。

import { verifySidecarPostRequest } from './auth.js';
import { getGame } from '../../lib/registry/store.js';
import { runStopWorkflow } from '../stop-workflow.js';
import type { Env } from '../../env.js';

interface IdleDetectedBody {
  game_id: string;
  instance_id: string;
  timestamp: number;
  last_player_seen_at: string;
}

export async function handleSidecarIdleDetected(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await verifySidecarPostRequest(request, env);
  if (!auth.ok) {
    console.warn(`sidecar idle-detected rejected: ${auth.reason}`);
    return new Response(null, { status: 401 });
  }

  let body: IdleDetectedBody;
  try {
    body = JSON.parse(auth.body) as IdleDetectedBody;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof body.instance_id !== 'string' || body.instance_id.length === 0) {
    return new Response(null, { status: 400 });
  }

  const game = await getGame(env.GAME_REGISTRY, auth.gameId);
  if (game === undefined) {
    return new Response(null, { status: 404 });
  }

  const gameId = auth.gameId;
  const expectedInstanceId = body.instance_id;
  ctx.waitUntil(
    (async () => {
      try {
        const outcome = await runStopWorkflow(env, ctx, game, {
          triggeredBy: 'sidecar',
          expectedInstanceId,
        });
        console.log(
          `[sidecar idle-detected] ${gameId} (expected=${expectedInstanceId}):`,
          JSON.stringify(outcome),
        );
      } catch (err) {
        console.error(`[sidecar idle-detected] ${gameId} workflow threw:`, err);
      }
    })(),
  );

  return new Response(null, { status: 202 });
}
