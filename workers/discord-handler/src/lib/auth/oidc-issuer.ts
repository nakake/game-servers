// OIDC issuer (Phase 5)。
//
// Worker 自身を OIDC issuer 化し、AWS STS の AssumeRoleWithWebIdentity 用に RS256 JWT を発行する。
// 詳細仕様: docs/phase5-plan.md Step 1。
//
// 設計原則:
//   - 鍵は env.OIDC_PRIVATE_KEYS_JWK (JWKS 形式の JSON) に**配列**で保管し、rotation 中の新旧並走を許す
//   - 最新 `created_at` の鍵を現用、旧鍵は JWKS endpoint で公開鍵を残しつつ署名には使わない
//   - `signOidcToken` は **module-private** (export しない、HTTP route から到達不能)。
//     外部呼び出しは `issueStsWebIdentityToken` (sub / aud / ttl を hardcode した STS 専用 wrapper) 経由のみ
//   - JWKS endpoint と discovery doc だけが public で、private key は外に出ない
//   - 呼び出し毎に新規 jti (UUID v4) を発行し、trust policy の UUID v4 pattern を満たす

import type { Env } from '../../env.js';

interface JwkPrivate {
  kid: string;
  kty: string;
  use?: string;
  alg?: string;
  n: string;
  e: string;
  d: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
  created_at?: number;
}

interface LoadedKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: { kty: string; n: string; e: string; kid: string; use: 'sig'; alg: 'RS256' };
  createdAt: number;
}

// module-scope cache — isolate 内で 1 度だけ import。reset 用は test only。
let cachedKeys: LoadedKey[] | undefined;

// テスト用にキャッシュをクリアする。production code からは呼ばない。
export function _resetKeyCache(): void {
  cachedKeys = undefined;
}

async function loadPrivateKeys(env: Env): Promise<LoadedKey[]> {
  if (cachedKeys !== undefined) return cachedKeys;
  if (env.OIDC_PRIVATE_KEYS_JWK === undefined || env.OIDC_PRIVATE_KEYS_JWK === '') {
    throw new Error('OIDC_PRIVATE_KEYS_JWK is not configured');
  }
  let parsed: { keys?: JwkPrivate[] };
  try {
    parsed = JSON.parse(env.OIDC_PRIVATE_KEYS_JWK) as { keys?: JwkPrivate[] };
  } catch (err) {
    throw new Error(`OIDC_PRIVATE_KEYS_JWK is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw new Error('OIDC_PRIVATE_KEYS_JWK must contain non-empty keys array');
  }
  const loaded: LoadedKey[] = await Promise.all(
    parsed.keys.map(async (jwk): Promise<LoadedKey> => {
      if (jwk.kid === undefined || jwk.kty !== 'RSA') {
        throw new Error('OIDC private key requires kid and kty=RSA');
      }
      // extractable=false で誤って export されないようにする (公開鍵は別途 publicJwk として保持)。
      const privateKey = await crypto.subtle.importKey(
        'jwk',
        jwk as JsonWebKey,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      return {
        kid: jwk.kid,
        privateKey,
        publicJwk: {
          kty: jwk.kty,
          n: jwk.n,
          e: jwk.e,
          kid: jwk.kid,
          use: 'sig',
          alg: 'RS256',
        },
        createdAt: jwk.created_at ?? 0,
      };
    }),
  );
  cachedKeys = loaded;
  return loaded;
}

function getIssuerUrl(env: Env): string {
  if (env.WORKER_PUBLIC_URL === undefined || env.WORKER_PUBLIC_URL === '') {
    throw new Error('WORKER_PUBLIC_URL is required to derive OIDC issuer URL');
  }
  return env.WORKER_PUBLIC_URL.replace(/\/+$/, '') + '/oidc';
}

interface SignOptions {
  sub: string;
  aud: string;
  ttlSeconds: number;
}

// module-private — export しない。外部呼び出しは issueStsWebIdentityToken 経由。
async function signOidcToken(env: Env, opts: SignOptions): Promise<string> {
  const keys = await loadPrivateKeys(env);
  // 最新 createdAt の鍵で署名 (rotation 中は新鍵を即時使用)。
  const newest = [...keys].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (newest === undefined) {
    throw new Error('No OIDC private keys loaded');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: newest.kid, typ: 'JWT' };
  const payload = {
    iss: getIssuerUrl(env),
    sub: opts.sub,
    aud: opts.aud,
    iat: now,
    nbf: now,
    exp: now + opts.ttlSeconds,
    jti: crypto.randomUUID(),
  };
  const signingInput = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(payload))}`;
  const sigBytes = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    newest.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64urlEncodeBytes(new Uint8Array(sigBytes))}`;
}

// AWS STS AssumeRoleWithWebIdentity 用の JWT を発行する。
// sub / aud / ttl を hardcode することで、任意 sub/aud の JWT 偽造を構造的に防ぐ。
// 呼び出し側 (lib/aws/credentials.ts、Step 3 で実装) から使う唯一のエントリ。
export async function issueStsWebIdentityToken(env: Env): Promise<string> {
  if (env.OIDC_SUB === undefined || env.OIDC_SUB === '') {
    throw new Error('OIDC_SUB is required to issue STS web identity token');
  }
  return signOidcToken(env, {
    sub: env.OIDC_SUB,
    aud: 'sts.amazonaws.com',
    ttlSeconds: 60,
  });
}

// JWKS endpoint で返す JSON。配列全件 (rotation 中は新旧両方公開)。
export async function buildJwks(env: Env): Promise<{ keys: LoadedKey['publicJwk'][] }> {
  const keys = await loadPrivateKeys(env);
  return { keys: keys.map((k) => k.publicJwk) };
}

// OIDC discovery doc。AWS STS が JWKS URI を取得するために fetch する。
export function buildDiscoveryDocument(issuerUrl: string): Record<string, unknown> {
  const normalized = issuerUrl.replace(/\/+$/, '');
  return {
    issuer: normalized,
    jwks_uri: `${normalized}/.well-known/jwks.json`,
    id_token_signing_alg_values_supported: ['RS256'],
    response_types_supported: ['id_token'],
    subject_types_supported: ['public'],
  };
}

// `env.WORKER_PUBLIC_URL` から OIDC issuer URL を導出する公開 helper (route handler 用)。
export function deriveIssuerUrl(env: Env): string {
  return getIssuerUrl(env);
}

// ---- helpers ----

function base64urlEncode(input: string): string {
  return base64urlEncodeBytes(new TextEncoder().encode(input));
}

function base64urlEncodeBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
