// CurseForge proxy ハンドラ (Phase 7)。
//   - GET /admin/api/modpacks/search?q=     modpack 検索        [player]
//   - GET /admin/api/modpacks/by-slug/:slug slug → 詳細 + 版一覧  [player]
//
// B-0b では scaffold (501)。実装は D-1。CurseForge client は lib/curseforge/ に置き、
// CF_API_KEY (Workers Secret) を x-api-key header で渡す (docs §3)。

import type { Env } from "../env.js";

export async function handleModpacksApi(
  _request: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return new Response(
    JSON.stringify({ error: "not implemented (Phase 7 D-1)" }),
    { status: 501, headers: { "content-type": "application/json" } },
  );
}
