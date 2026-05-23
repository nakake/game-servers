// /sidecar/* リクエストの HMAC 認証共通モジュール (Phase 3、docs/phase3-plan.md 決定10)。
//
// POST 用 / GET 用の 2 関数を提供する。どちらも:
//   1. X-Sidecar-Timestamp / X-Sidecar-Signature ヘッダを取り出す
//   2. SIDECAR_HMAC_SECRETS (JSON map `{<game_id>: <secret>}`) から該当 secret を引く
//   3. payload を再正規化し crypto.subtle.verify で照合する
// 失敗は具体的な `reason` を返し、ハンドラはログだけ詳細を出して response は最小情報で
// 返す (攻撃者への enumeration 防止)。

import { formatGetPayload, formatPostPayload, verifyHmac } from '../../lib/auth/hmac.js';
import type { Env } from '../../env.js';

export type SidecarAuthFailureReason =
  | 'missing-headers'
  | 'invalid-timestamp'
  | 'invalid-body'
  | 'missing-game-id'
  | 'unknown-game'
  | 'invalid-signature'
  | 'misconfigured-secrets';

export interface SidecarAuthSuccessPost {
  ok: true;
  gameId: string;
  // body は HMAC 検証で 1 度 text() を消費しているため、handler はここから受け取って JSON parse する。
  body: string;
  timestamp: number;
}

export interface SidecarAuthSuccessGet {
  ok: true;
  gameId: string;
  timestamp: number;
}

export interface SidecarAuthFailure {
  ok: false;
  reason: SidecarAuthFailureReason;
}

export async function verifySidecarPostRequest(
  request: Request,
  env: Env,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SidecarAuthSuccessPost | SidecarAuthFailure> {
  const headers = extractAuthHeaders(request);
  if (headers === null) return { ok: false, reason: 'missing-headers' };

  // POST は body も payload に含まれるため、ここで一度だけ読み取る (request.body は 1 回しか
  // 消費できない)。検証成功時は handler に文字列で渡す。
  const body = await request.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'invalid-body' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'invalid-body' };
  }
  const gameIdRaw = (parsed as Record<string, unknown>)['game_id'];
  if (typeof gameIdRaw !== 'string' || gameIdRaw.length === 0) {
    return { ok: false, reason: 'missing-game-id' };
  }
  const gameId = gameIdRaw;

  const secret = lookupSecret(env, gameId);
  if (secret === null) return { ok: false, reason: 'misconfigured-secrets' };
  if (secret === undefined) return { ok: false, reason: 'unknown-game' };

  const payload = formatPostPayload(headers.timestamp, body);
  const valid = await verifyHmac({
    payload,
    signature: headers.signature,
    secret,
    timestamp: headers.timestamp,
    now,
  });
  if (!valid) return { ok: false, reason: 'invalid-signature' };

  return { ok: true, gameId, body, timestamp: headers.timestamp };
}

export async function verifySidecarGetRequest(
  request: Request,
  env: Env,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SidecarAuthSuccessGet | SidecarAuthFailure> {
  const headers = extractAuthHeaders(request);
  if (headers === null) return { ok: false, reason: 'missing-headers' };

  const url = new URL(request.url);
  const gameId = url.searchParams.get('game_id');
  if (gameId === null || gameId.length === 0) {
    return { ok: false, reason: 'missing-game-id' };
  }

  const secret = lookupSecret(env, gameId);
  if (secret === null) return { ok: false, reason: 'misconfigured-secrets' };
  if (secret === undefined) return { ok: false, reason: 'unknown-game' };

  // GET の path_with_query は受信時のまま (Worker 側 URL parser は順序を保持する)。
  const pathWithQuery = url.pathname + url.search;
  const payload = formatGetPayload(request.method, pathWithQuery, headers.timestamp);
  const valid = await verifyHmac({
    payload,
    signature: headers.signature,
    secret,
    timestamp: headers.timestamp,
    now,
  });
  if (!valid) return { ok: false, reason: 'invalid-signature' };

  return { ok: true, gameId, timestamp: headers.timestamp };
}

interface AuthHeaders {
  timestamp: number;
  signature: string;
}

function extractAuthHeaders(request: Request): AuthHeaders | null {
  const tsHeader = request.headers.get('x-sidecar-timestamp');
  const sigHeader = request.headers.get('x-sidecar-signature');
  if (tsHeader === null || sigHeader === null || sigHeader.length === 0) return null;
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) return null;
  return { timestamp: ts, signature: sigHeader };
}

// 戻り値:
//   string    — secret を引けた
//   undefined — JSON は parse できたが該当 game_id が無い (unknown-game)
//   null      — JSON parse 失敗等の deploy ミス (misconfigured-secrets)
function lookupSecret(env: Env, gameId: string): string | undefined | null {
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(env.SIDECAR_HMAC_SECRETS) as Record<string, unknown>;
  } catch (err) {
    console.error('SIDECAR_HMAC_SECRETS is not valid JSON:', err);
    return null;
  }
  const v = map[gameId];
  if (typeof v !== 'string' || v.length === 0) return undefined;
  return v;
}
