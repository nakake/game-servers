// GET /sidecar/registry?game_id=<id> — sidecar が起動時に 1 回呼んで registry を取得する。
//
// docs/phase3-plan.md 決定8 の経路。KV を single source of truth に保つため、user-data に
// registry を埋め込まず Worker から HMAC 認証付きで配布する。
//
// 認証失敗 → 401、enabled=false / 未登録 → 404。sidecar は 4xx を「自爆して container を終了」
// のシグナルにし、cloud-init 側の `--restart unless-stopped` がループしないよう exit する。

import { verifySidecarGetRequest } from './auth.js';
import { getGame } from '../../lib/registry/store.js';
import type { Env } from '../../env.js';

export async function handleSidecarRegistry(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await verifySidecarGetRequest(request, env);
  if (!auth.ok) {
    console.warn(`sidecar registry rejected: ${auth.reason}`);
    return new Response(null, { status: 401 });
  }

  const game = await getGame(env.GAME_REGISTRY, auth.gameId);
  if (game === undefined || !game.enabled) {
    return new Response(null, { status: 404 });
  }

  return Response.json(game);
}
