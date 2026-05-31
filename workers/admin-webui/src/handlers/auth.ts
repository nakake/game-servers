// 認証ハンドラ (Phase 7、ADR 0003)。
//   - GET  /auth?t=<token>         magic link landing: token 検証 → session cookie 発行
//   - POST /admin/api/auth/logout  現 session の失効
//
// B-0b では scaffold (501)。実装は B-2 (magic link auth) で行う:
//   - token 検証 (one-shot / TTL / log redact)
//   - allowlist から tier 導出 (fail-closed)
//   - opaque session id を ADMIN_AUTH に put + Secure/HttpOnly/SameSite=Strict cookie

import type { Env } from "../env.js";

export async function handleAuth(
  _request: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return new Response(
    JSON.stringify({ error: "not implemented (Phase 7 B-2)" }),
    { status: 501, headers: { "content-type": "application/json" } },
  );
}
