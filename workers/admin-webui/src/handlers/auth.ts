// 認証ハンドラ (Phase 7 B-2、ADR 0003 / docs §4)。
//   - GET  /auth?t=<token>         magic link landing: token 検証 → tier 判定 → session cookie
//   - POST /admin/api/auth/logout  現 session の失効
//
// セキュリティ (docs §9):
//   - token は **ログに出さない** (#6)。検証成否のみ log する。
//   - tier は allowlist から導出し、どちらにも無ければ 403 で session を作らない (fail-closed #2)。
//   - landing HTML は inline script (history.replaceState で ?t= を URL から消す #4) を
//     CSP nonce 付きで許可する (script-src 'nonce-...'、#5)。
//   - logout は状態変更なので X-Requested-With header を要求する (CSRF 軽減 §4.3)。

import { deriveTier, generateOpaqueToken } from "@gs/shared/auth-types";
import {
  clearSessionCookie,
  consumeAdminToken,
  createSession,
  destroySession,
  readSessionId,
} from "../lib/auth/admin-session.js";
import type { Env } from "../env.js";

export async function handleAuth(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/auth") {
    return handleLanding(request, env, url);
  }
  if (url.pathname === "/admin/api/auth/logout") {
    return handleLogout(request, env);
  }
  return jsonError(404, "unknown auth route");
}

// GET /auth?t=<token>
async function handleLanding(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonError(405, "method not allowed");
  }

  const token = url.searchParams.get("t");
  // token は絶対にログに出さない (有無のみ)。
  console.log("[auth] landing", { hasToken: token !== null });

  const consumed = await consumeAdminToken(env.ADMIN_AUTH, token);
  if (consumed === null) {
    return landingError(
      401,
      "リンクが無効か、期限切れです。Discord で `/panel` をもう一度実行してください。",
    );
  }

  const tier = deriveTier(
    consumed.user_id,
    env.ADMIN_DISCORD_USER_IDS,
    env.PLAYER_DISCORD_USER_IDS,
  );
  if (tier === null) {
    // 発行者が allowlist のどちらにも無い (fail-closed)。session は作らない。
    return landingError(
      403,
      "このアカウントには管理画面の利用権限がありません。",
    );
  }

  const { cookie } = await createSession(env.ADMIN_AUTH, consumed.user_id);

  // ?t= を履歴から消し / にリダイレクトする。inline script は nonce で許可。
  const nonce = generateOpaqueToken(16);
  const html =
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>gs-admin</title></head><body>" +
    "<p>認証しました。リダイレクトしています…</p>" +
    `<script nonce="${nonce}">history.replaceState(null,'','/');location.href='/';</script>` +
    "</body></html>";

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": cookie,
      "content-security-policy": `default-src 'self'; script-src 'nonce-${nonce}'`,
      "cache-control": "no-store",
    },
  });
}

// POST /admin/api/auth/logout
async function handleLogout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError(405, "method not allowed");
  }
  // 状態変更 API は X-Requested-With を要求 (CSRF 軽減、docs §4.3)。
  if (request.headers.get("x-requested-with") === null) {
    return jsonError(403, "missing X-Requested-With");
  }

  const sid = readSessionId(request.headers.get("cookie"));
  if (sid !== null) {
    await destroySession(env.ADMIN_AUTH, sid);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": clearSessionCookie(),
    },
  });
}

// 認証失敗時の HTML (人間向け、最小)。session cookie は付けない。
function landingError(status: number, message: string): Response {
  const html =
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>gs-admin</title></head><body>" +
    `<h1>認証エラー</h1><p>${escapeHtml(message)}</p>` +
    "</body></html>";
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
