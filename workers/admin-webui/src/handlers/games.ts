// game CRUD + ops ハンドラ (Phase 7)。
//   - GET    /admin/api/games            一覧 (KV scan)            [player]
//   - GET    /admin/api/games/:id        単体取得                  [player]
//   - PUT    /admin/api/games/:id        更新 (コスト fields は admin) [player]
//   - POST   /admin/api/games            新規追加                  [player]   ← D-2
//   - POST   /admin/api/games/:id/start  起動 (RPC 委譲)           [player]   ← E-2
//   - POST   /admin/api/games/:id/stop   停止 (RPC 委譲)           [player]   ← E-2
//   - GET    /admin/api/games/:id/status 状態 (RPC 委譲)           [player]   ← E-2
//
// B-3 で実装するのは一覧 / 取得 / 更新。新規追加 (POST) と ops は後続 Step。
// 全 endpoint で Cookie 認証必須。コスト fields の enforcement は @gs/shared の
// applyGameUpdate(existing, update, tier) に集約する (docs §5.3 / §6 / §9.1 #2b)。

import { applyGameUpdate } from "@gs/shared/build";
import type { GameDefinition } from "@gs/shared/registry-types";
import { authenticate } from "../lib/auth/admin-session.js";
import { getGame, listGames, putGame } from "../lib/registry/store.js";
import type { Env } from "../env.js";

export async function handleGamesApi(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  // 全 endpoint で認証必須。fail-closed (session 無効 / allowlist 外は 401)。
  const auth = await authenticate(env, request);
  if (auth === null) {
    return jsonError(401, "unauthorized");
  }

  const url = new URL(request.url);
  // /admin/api/games  /admin/api/games/:id  /admin/api/games/:id/<sub> を分解。
  const rest = url.pathname.replace(/^\/admin\/api\/games\/?/, "");
  const segments = rest.split("/").filter((s) => s.length > 0);

  // /admin/api/games (一覧 / 新規)
  if (segments.length === 0) {
    if (request.method === "GET") return listHandler(env);
    if (request.method === "POST") {
      // D-2 で実装。
      return jsonError(501, "not implemented (Phase 7 D-2)");
    }
    return jsonError(405, "method not allowed");
  }

  const gameId = decodeURIComponent(segments[0]!);
  const sub = segments[1];

  // /admin/api/games/:id/<sub> (start/stop/status) は E-2。
  if (sub !== undefined) {
    return jsonError(501, "not implemented (Phase 7 E-2)");
  }

  // /admin/api/games/:id
  if (request.method === "GET") return getHandler(env, gameId);
  if (request.method === "PUT")
    return putHandler(request, env, gameId, auth.tier);
  return jsonError(405, "method not allowed");
}

async function listHandler(env: Env): Promise<Response> {
  const games = await listGames(env.GAME_REGISTRY);
  return json(200, { games });
}

async function getHandler(env: Env, gameId: string): Promise<Response> {
  const game = await getGame(env.GAME_REGISTRY, gameId);
  if (game === undefined) return jsonError(404, `unknown game: ${gameId}`);
  return json(200, { game });
}

async function putHandler(
  request: Request,
  env: Env,
  gameId: string,
  tier: "admin" | "player",
): Promise<Response> {
  // 状態変更 API は X-Requested-With を要求 (CSRF 軽減、docs §4.3)。
  if (request.headers.get("x-requested-with") === null) {
    return jsonError(403, "missing X-Requested-With");
  }

  const existing = await getGame(env.GAME_REGISTRY, gameId);
  if (existing === undefined) return jsonError(404, `unknown game: ${gameId}`);

  let update: Partial<GameDefinition>;
  try {
    update = (await request.json()) as Partial<GameDefinition>;
  } catch {
    return jsonError(400, "invalid JSON body");
  }
  if (typeof update !== "object" || update === null || Array.isArray(update)) {
    return jsonError(400, "body must be an object");
  }

  // **enforcement**: player のコスト系 field 更新はここで無視される (applyGameUpdate)。
  const next = applyGameUpdate(existing, update, tier);
  await putGame(env.GAME_REGISTRY, next);
  return json(200, { game: next });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status: number, message: string): Response {
  return json(status, { error: message });
}
