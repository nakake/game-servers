// magic link 認証の共有契約 (Phase 7 B-2、ADR 0003 / docs §4-5)。
//
// discord-handler (token 発行) と admin-webui (token 検証 + session) が同じ KV namespace
// (ADMIN_AUTH) を共有するため、key prefix / record 形 / TTL / tier 導出をここに一元化して
// 両 Worker のドリフトを防ぐ。AWS / OIDC ロジックは入れない (鍵隔離、ADR 0004) — pure のみ。

import type { Tier } from "./registry-types.js";

// ---- KV record (docs §5.2) ----

// admin_token:<token> — one-shot magic link token。discord-handler の /panel が put し、
// admin-webui の /auth が読んで used=true に倒す。
export interface AdminTokenRecord {
  user_id: string; // 発行者 (= /panel を叩いた Discord user)
  issued_at: number; // epoch ms
  exp_ts: number; // epoch ms
  used: boolean;
}

// admin_session:<sid> — session の実体。admin-webui のみが扱う。tier は焼かず毎req再導出。
export interface AdminSessionRecord {
  user_id: string;
  issued_at: number; // epoch ms
  exp_ts: number; // epoch ms
}

// ---- KV key (docs §5.2) ----

export const ADMIN_TOKEN_PREFIX = "admin_token:";
export const ADMIN_SESSION_PREFIX = "admin_session:";

// URL に乗る token の漏洩窓を縮める (docs §4.1)。
export const ADMIN_TOKEN_TTL_SECONDS = 300;
// session の寿命 (docs §4.2 step 6)。
export const ADMIN_SESSION_TTL_SECONDS = 86400;

export function adminTokenKey(token: string): string {
  return `${ADMIN_TOKEN_PREFIX}${token}`;
}

export function adminSessionKey(sid: string): string {
  return `${ADMIN_SESSION_PREFIX}${sid}`;
}

// ---- token / sid 生成 ----

// 32 bytes CSPRNG → base64url (docs §4.1)。token (magic link) と sid (session) の両方に使う。
// crypto.getRandomValues / btoa は Workers / Node 22 のどちらでも global で利用可能。
export function generateOpaqueToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---- tier 導出 (docs §1.1 / §4) ----

// CSV allowlist を trim 済みの非空 id 集合に変換する。undefined / 空文字は空集合。
export function parseAllowlist(csv: string | undefined): Set<string> {
  if (!csv) return new Set();
  return new Set(
    csv
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

// user_id の tier を allowlist から導出する。**fail-closed**: どちらにも無ければ null。
// admin と player の両方に入っている場合は admin 優先 (docs §4.2 step 4)。
// session に焼かず毎リクエスト呼ぶ前提 — allowlist の変更が次リクエストで即反映される。
export function deriveTier(
  userId: string,
  adminCsv: string | undefined,
  playerCsv: string | undefined,
): Tier | null {
  if (!userId) return null;
  if (parseAllowlist(adminCsv).has(userId)) return "admin";
  if (parseAllowlist(playerCsv).has(userId)) return "player";
  return null;
}
