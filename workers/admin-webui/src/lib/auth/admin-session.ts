// magic link 認証の admin-webui 側コア (Phase 7 B-2、ADR 0003 / docs §4)。
//
//   - consumeAdminToken : /panel が発行した one-shot token を検証 + used=true に倒す
//   - createSession     : opaque session id を発行し ADMIN_AUTH に put
//   - getSessionRecord  : session id から record を引く (TTL 切れは null)
//   - authenticate      : cookie → session → **allowlist から tier を毎回再導出** (fail-closed)
//   - destroySession    : 単一 session の失効 (logout)
//   - cookie helpers     : Secure; HttpOnly; SameSite=Strict
//
// session に tier を焼かず毎リクエスト allowlist から再導出する (docs §4.2 step 6 / §4.3):
// allowlist から外した user / 昇格が次リクエストで即反映され、最大 24h の stale を避ける。

import {
  ADMIN_SESSION_TTL_SECONDS,
  adminSessionKey,
  adminTokenKey,
  deriveTier,
  generateOpaqueToken,
  type AdminSessionRecord,
  type AdminTokenRecord,
} from "@gs/shared/auth-types";
import type { Tier } from "@gs/shared/registry-types";
import type { Env } from "../../env.js";

export const SESSION_COOKIE = "gs_admin_session";

// KV の最小 TTL (Cloudflare KV は expirationTtl >= 60 を要求)。
const MIN_KV_TTL_SECONDS = 60;

export interface AuthenticatedRequest {
  userId: string;
  tier: Tier;
}

// one-shot token を検証する。valid(未使用かつ未失効) なら発行者 user_id を返し、token を
// used=true に倒す。それ以外 (未存在 / 使用済 / 失効 / 壊れた JSON) は null。
// race condition は許容 (docs §9.1 #7) — KV は eventually-consistent。
export async function consumeAdminToken(
  kv: KVNamespace,
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<{ user_id: string } | null> {
  if (!token) return null;
  const key = adminTokenKey(token);
  const raw = await kv.get(key);
  if (raw === null) return null;

  let record: AdminTokenRecord;
  try {
    record = JSON.parse(raw) as AdminTokenRecord;
  } catch {
    return null;
  }
  if (record.used || record.exp_ts <= now) return null;

  // tombstone として used=true を残す (残り TTL 内、最低 60s)。
  const remainingSec = Math.max(
    MIN_KV_TTL_SECONDS,
    Math.ceil((record.exp_ts - now) / 1000),
  );
  await kv.put(key, JSON.stringify({ ...record, used: true }), {
    expirationTtl: remainingSec,
  });
  return { user_id: record.user_id };
}

// 新規 session を発行する。sid と Set-Cookie 文字列を返す。
export async function createSession(
  kv: KVNamespace,
  userId: string,
  now: number = Date.now(),
): Promise<{ sid: string; cookie: string }> {
  const sid = generateOpaqueToken();
  const record: AdminSessionRecord = {
    user_id: userId,
    issued_at: now,
    exp_ts: now + ADMIN_SESSION_TTL_SECONDS * 1000,
  };
  await kv.put(adminSessionKey(sid), JSON.stringify(record), {
    expirationTtl: ADMIN_SESSION_TTL_SECONDS,
  });
  return { sid, cookie: sessionCookie(sid) };
}

// session id から record を引く。未存在 / 失効 / 壊れた JSON は null。
export async function getSessionRecord(
  kv: KVNamespace,
  sid: string,
  now: number = Date.now(),
): Promise<AdminSessionRecord | null> {
  const raw = await kv.get(adminSessionKey(sid));
  if (raw === null) return null;
  let record: AdminSessionRecord;
  try {
    record = JSON.parse(raw) as AdminSessionRecord;
  } catch {
    return null;
  }
  if (record.exp_ts <= now) return null;
  return record;
}

// request の cookie から session を検証し、tier を allowlist から再導出する。
// session 無効 or allowlist から外れている (= 元 admin/player が剥奪された) 場合は null。
export async function authenticate(
  env: Env,
  request: Request,
  now: number = Date.now(),
): Promise<AuthenticatedRequest | null> {
  const sid = readSessionId(request.headers.get("cookie"));
  if (sid === null) return null;
  const record = await getSessionRecord(env.ADMIN_AUTH, sid, now);
  if (record === null) return null;
  const tier = deriveTier(
    record.user_id,
    env.ADMIN_DISCORD_USER_IDS,
    env.PLAYER_DISCORD_USER_IDS,
  );
  if (tier === null) return null;
  return { userId: record.user_id, tier };
}

// 単一 session の失効 (logout)。
export async function destroySession(
  kv: KVNamespace,
  sid: string,
): Promise<void> {
  await kv.delete(adminSessionKey(sid));
}

// ---- cookie helpers ----

export function readSessionId(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

export function sessionCookie(sid: string): string {
  return [
    `${SESSION_COOKIE}=${sid}`,
    "Secure",
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
  ].join("; ");
}

export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE}=`,
    "Secure",
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ].join("; ");
}
