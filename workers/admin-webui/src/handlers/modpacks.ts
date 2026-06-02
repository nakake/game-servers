// CurseForge proxy ハンドラ (Phase 7 D-1、docs §3 / §6)。
//   - GET /admin/api/modpacks/search?q=     modpack 検索 (CF 1 call)         [player]
//   - GET /admin/api/modpacks/by-slug/:slug slug → 詳細 + 版一覧 (CF 2 call)  [player]
//
// 認証は games API と同じ authenticate() (fail-closed)。両 endpoint とも player 可
// (tier gating なし — 検索/参照はコスト系操作ではない)。CF への呼び出しは
// lib/curseforge/ の CurseForgeClient に委譲し、CF_API_KEY (Workers Secret) を
// x-api-key で渡す。CurseForgeApiError は upstream 系の HTTP status (429 はそのまま、
// それ以外は 502) に正規化して返す (docs §11.3、本番で 429 が出てから cache/backoff)。

import { authenticate } from "../lib/auth/admin-session.js";
import { CurseForgeClient } from "../lib/curseforge/client.js";
import { CurseForgeApiError } from "../lib/curseforge/errors.js";
import type { ModpackSummary } from "../lib/curseforge/types.js";
import type { Env } from "../env.js";

// by-slug のバージョン一覧は latestFiles (release channel 毎の最新数件) より広く見せたいので、
// listFiles を CF 上限で引いて版選択 UI に十分なリストを返す。
const BY_SLUG_FILE_PAGE_SIZE = 50;

export async function handleModpacksApi(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  // 全 endpoint で認証必須。fail-closed (session 無効 / allowlist 外は 401)。
  const auth = await authenticate(env, request);
  if (auth === null) return jsonError(401, "unauthorized");

  if (request.method !== "GET") return jsonError(405, "method not allowed");

  const url = new URL(request.url);
  // /admin/api/modpacks/search  /admin/api/modpacks/by-slug/:slug を分解。
  const rest = url.pathname.replace(/^\/admin\/api\/modpacks\/?/, "");
  const segments = rest.split("/").filter((s) => s.length > 0);

  const client = new CurseForgeClient({ apiKey: env.CF_API_KEY });

  try {
    if (segments[0] === "search" && segments.length === 1) {
      return await searchHandler(client, url);
    }
    if (segments[0] === "by-slug" && segments.length === 2) {
      return await bySlugHandler(client, segments[1]!);
    }
    return jsonError(404, "unknown modpacks route");
  } catch (err) {
    if (err instanceof CurseForgeApiError) {
      // 429 は rate limit として SPA にそのまま晒す。それ以外の upstream エラー
      // (4xx/5xx/network) は 502 に丸める (CF の内部 status を漏らさない)。
      const status = err.statusCode === 429 ? 429 : 502;
      return jsonError(status, "curseforge upstream error");
    }
    throw err;
  }
}

async function searchHandler(
  client: CurseForgeClient,
  url: URL,
): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q === "") return jsonError(400, "missing query parameter: q");
  const modpacks = await client.searchModpacks(q);
  return json(200, { modpacks });
}

async function bySlugHandler(
  client: CurseForgeClient,
  rawSlug: string,
): Promise<Response> {
  const slug = decodeURIComponent(rawSlug).trim();
  if (slug === "") return jsonError(400, "missing slug");

  // CF call 1: slug → modId + メタ (完全一致が無ければ undefined)。
  const detail = await client.resolveSlug(slug);
  if (detail === undefined) return jsonError(404, `unknown modpack: ${slug}`);

  // CF call 2: 版一覧。detail.latestFiles より広い版リストを版選択 UI に渡す。
  const files = await client.listFiles(detail.modId, {
    pageSize: BY_SLUG_FILE_PAGE_SIZE,
  });

  // latestFiles は files に内包されるので落とし、メタ (ModpackSummary) のみ返す。
  const modpack: ModpackSummary = {
    modId: detail.modId,
    slug: detail.slug,
    name: detail.name,
    summary: detail.summary,
  };
  // exactOptionalPropertyTypes: 値があるときだけ key を生やす。
  if (detail.thumbnailUrl !== undefined)
    modpack.thumbnailUrl = detail.thumbnailUrl;

  return json(200, { modpack, files });
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
