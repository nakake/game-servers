// admin-webui Worker のエントリポイント (Phase 7、ADR 0004)。
//
// ルーティングのみ担当する:
//   - /auth                 magic link landing (token 検証 → session cookie)
//   - /admin/api/auth/*      logout 等の認証 API
//   - /admin/api/modpacks/*  CurseForge proxy
//   - /admin/api/games*      game CRUD + ops (start/stop/status)
//   - それ以外               SPA static assets (env.ASSETS.fetch)
//
// 認証 / tier の enforcement は各 handler 側の middleware で行う (docs §4.3)。
// この index は path 振り分けに徹する。

import type { Env } from "./env.js";
import { handleAuth } from "./handlers/auth.js";
import { handleGamesApi } from "./handlers/games.js";
import { handleModpacksApi } from "./handlers/modpacks.js";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // magic link landing。token は ?t= で渡る (handler 内で log redact)。
    if (pathname === "/auth") {
      return handleAuth(request, env, ctx);
    }

    // JSON API (Cookie 認証必須、handler 側で検証)。
    if (pathname.startsWith("/admin/api/")) {
      // logout 等の認証系は auth handler が扱う。
      if (pathname.startsWith("/admin/api/auth/")) {
        return handleAuth(request, env, ctx);
      }
      if (pathname.startsWith("/admin/api/modpacks")) {
        return handleModpacksApi(request, env, ctx);
      }
      if (pathname.startsWith("/admin/api/games")) {
        return handleGamesApi(request, env, ctx);
      }
      return jsonError(404, "unknown API route");
    }

    // それ以外は SPA static assets に委譲 (not_found_handling=SPA で index.html に fallback)。
    return env.ASSETS.fetch(request);
  },
};

// JSON エラー応答の共通ヘルパ。
function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
