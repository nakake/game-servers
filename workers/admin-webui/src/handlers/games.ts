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

import {
  applyGameUpdate,
  buildGameDefinition,
  validateNewGameForm,
} from "@gs/shared/build";
import type { GameDefinition } from "@gs/shared/registry-types";
import { authenticate } from "../lib/auth/admin-session.js";
import { CloudflareDnsClient } from "../lib/cloudflare/dns.js";
import { CloudflareApiError } from "../lib/cloudflare/errors.js";
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
    if (request.method === "POST") return postHandler(request, env, auth.tier);
    return jsonError(405, "method not allowed");
  }

  const gameId = decodeURIComponent(segments[0]!);
  const sub = segments[1];

  // /admin/api/games/:id/<sub> (start/stop/status) — AWS 操作は RPC 委譲 (E-2)。
  if (sub !== undefined) {
    if (segments.length !== 2) return jsonError(404, "unknown route");
    return opsHandler(request, env, gameId, sub);
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

// 新規ゲーム追加 (D-2)。検証 → game_id 重複チェック → DNS A 作成 (admin-webui 直) → KV put。
//
// **S3 config sync / SSM rcon password は行わない**: AUTO_CURSEFORGE のゲームは boot 時に
// itzg が CF から pack を取得するため、追加時点で S3 config は不要。SSM rcon password の
// provisioning は AWS 操作で admin-webui には鍵が無いため、Service Binding RPC (E-1) 経路で
// 別途用意する (docs §6.1)。初回の実起動 (D-3) でこの不足が顕在化する想定。
async function postHandler(
  request: Request,
  env: Env,
  tier: "admin" | "player",
): Promise<Response> {
  if (request.headers.get("x-requested-with") === null) {
    return jsonError(403, "missing X-Requested-With");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid JSON body");
  }

  const parsed = validateNewGameForm(body);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const form = parsed.value;

  // 既存 game_id への上書きを防ぐ (KV put は同 key を黙って上書きするため)。
  const existing = await getGame(env.GAME_REGISTRY, form.game_id);
  if (existing !== undefined) {
    return jsonError(409, `game already exists: ${form.game_id}`);
  }

  // DNS A レコードを placeholder IP で作成 (冪等)。実 IP は /start 時に書き換わる。
  const fqdn = `${form.subdomain}.${env.CLOUDFLARE_BASE_DOMAIN}`;
  const dns = new CloudflareDnsClient({
    apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
  });
  let recordId: string;
  try {
    recordId = await dns.ensureARecord({
      zoneId: env.CLOUDFLARE_ZONE_ID,
      name: fqdn,
      comment: `gs-${form.game_id} added via admin-webui`,
    });
  } catch (err) {
    if (err instanceof CloudflareApiError) {
      return jsonError(502, "cloudflare dns error");
    }
    throw err;
  }

  // 純粋変換で GameDefinition を組み立て (player のコスト field は既定強制) → KV put。
  const game = buildGameDefinition(form, tier, recordId);
  await putGame(env.GAME_REGISTRY, game);
  return json(201, { game });
}

// start/stop/status (E-2)。AWS 操作は admin-webui に鍵が無いので、discord-handler の
// InternalRpc (WorkerEntrypoint) に Service Binding RPC で委譲する (ADR 0004 / docs §6.1)。
// start/stop は状態変更なので X-Requested-With 必須、status は GET。
async function opsHandler(
  request: Request,
  env: Env,
  gameId: string,
  sub: string,
): Promise<Response> {
  const requireXrw = (): Response | null =>
    request.headers.get("x-requested-with") === null
      ? jsonError(403, "missing X-Requested-With")
      : null;

  try {
    if (sub === "start") {
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      const bad = requireXrw();
      if (bad !== null) return bad;
      // start は受付のみ (RPC が waitUntil で後追い)。ok:true=受理 → 202、ok:false=
      // 検証却下 (未登録/無効) → 409。完了は SPA が status polling で確認する。
      const result = await env.DISCORD_HANDLER.start(gameId);
      return json(result.ok ? 202 : 409, { result });
    }
    if (sub === "stop") {
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      const bad = requireXrw();
      if (bad !== null) return bad;
      const result = await env.DISCORD_HANDLER.stop(gameId);
      return json(result.ok ? 202 : 409, { result });
    }
    if (sub === "status") {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      const result = await env.DISCORD_HANDLER.status(gameId);
      return json(200, { result });
    }
    return jsonError(404, `unknown op: ${sub}`);
  } catch (err) {
    // RPC 自体の失敗 (binding 不在 / discord-handler 例外)。AWS の内部詳細は漏らさない。
    console.error(`ops RPC ${sub} failed:`, err);
    return jsonError(502, `ops failed: ${sub}`);
  }
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
