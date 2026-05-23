// POST /sidecar/heartbeat — sidecar が `heartbeat_interval_sec` ごとに送る生存報告。
//
// Worker は重い処理をせず、KV `last-seen:<game_id>` を更新するだけ。TTL は registry の
// `idle_check.timeout_min * 3` 分に設定する (Cron フォールバックの判定窓に余裕を持たせるため)。
// レスポンスは 204 (No Content)。

import { verifySidecarPostRequest } from './auth.js';
import { storeLastSeen } from '../../lib/state/last-seen.js';
import { getGame } from '../../lib/registry/store.js';
import type { Env } from '../../env.js';

interface HeartbeatBody {
  game_id: string;
  instance_id: string;
  timestamp: number;
  player_count: number;
}

export async function handleSidecarHeartbeat(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await verifySidecarPostRequest(request, env);
  if (!auth.ok) {
    console.warn(`sidecar heartbeat rejected: ${auth.reason}`);
    return new Response(null, { status: 401 });
  }

  let body: HeartbeatBody;
  try {
    body = JSON.parse(auth.body) as HeartbeatBody;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (
    typeof body.instance_id !== 'string' ||
    body.instance_id.length === 0 ||
    typeof body.player_count !== 'number' ||
    !Number.isFinite(body.player_count)
  ) {
    return new Response(null, { status: 400 });
  }

  const game = await getGame(env.GAME_REGISTRY, auth.gameId);
  if (game === undefined) {
    // 認証は通ったが registry から消えている (`register-game.mjs` で消した直後など)。
    // sidecar 側は次回 `/sidecar/registry` でも 404 を見て自爆する想定。
    return new Response(null, { status: 404 });
  }

  // timeout_min * 3 分の余裕 (Cron フォールバックは `timeout_min + 5min` で判定、その後
  // しばらく古い entry を見ても問題ないように 3 倍を持たせる)。
  const ttlSec = game.idle_check.timeout_min * 60 * 3;

  await storeLastSeen(
    env.SERVER_STATE,
    {
      gameId: auth.gameId,
      instanceId: body.instance_id,
      lastSeenAt: new Date().toISOString(),
      playerCount: body.player_count,
    },
    ttlSec,
  );

  return new Response(null, { status: 204 });
}
