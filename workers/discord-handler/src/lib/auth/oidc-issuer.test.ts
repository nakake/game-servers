import { exportJWK, generateKeyPair, jwtVerify, importJWK } from 'jose';
import type { JWK } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetKeyCache,
  buildDiscoveryDocument,
  buildJwks,
  deriveIssuerUrl,
  issueStsWebIdentityToken,
} from './oidc-issuer.js';
import type { Env } from '../../env.js';

const ISSUER_HOST = 'https://discord-handler.example.workers.dev';
const ISSUER_URL = `${ISSUER_HOST}/oidc`;
const TEST_SUB = 'discord-handler-abc12345';

// テスト用に RSA 鍵ペアを生成し、private JWK (Worker secret に入る形式) を返す。
async function generateTestKey(
  kid: string,
  createdAt: number,
): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  return {
    privateJwk: { ...privateJwk, kid, alg: 'RS256', use: 'sig', created_at: createdAt } as JWK,
    publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' },
  };
}

function makeEnv(opts: {
  privateKeys: unknown[];
  sub?: string;
  publicUrl?: string;
}): Env {
  const env: Record<string, unknown> = {
    OIDC_PRIVATE_KEYS_JWK: JSON.stringify({ keys: opts.privateKeys }),
    WORKER_PUBLIC_URL: opts.publicUrl ?? ISSUER_HOST,
  };
  if (opts.sub !== undefined) env.OIDC_SUB = opts.sub;
  return env as unknown as Env;
}

// JWT を 3 つに分解して header / payload を返す (test inspection 用、署名は jose で別途検証)。
function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [headerB64, payloadB64] = jwt.split('.');
  if (headerB64 === undefined || payloadB64 === undefined) {
    throw new Error('JWT format invalid');
  }
  const decode = (s: string): Record<string, unknown> =>
    JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
      ),
    ) as Record<string, unknown>;
  return { header: decode(headerB64), payload: decode(payloadB64) };
}

beforeEach(() => {
  _resetKeyCache();
});

afterEach(() => {
  _resetKeyCache();
});

describe('issueStsWebIdentityToken', () => {
  it('発行した JWT を JWKS の公開鍵で検証できる', async () => {
    const key = await generateTestKey('kid-1', 1_700_000_000);
    const env = makeEnv({ privateKeys: [key.privateJwk], sub: TEST_SUB });

    const jwt = await issueStsWebIdentityToken(env);
    const publicKey = await importJWK(key.publicJwk, 'RS256');
    const { payload, protectedHeader } = await jwtVerify(jwt, publicKey, {
      issuer: ISSUER_URL,
      audience: 'sts.amazonaws.com',
    });

    expect(protectedHeader.alg).toBe('RS256');
    expect(protectedHeader.kid).toBe('kid-1');
    expect(protectedHeader.typ).toBe('JWT');
    expect(payload.iss).toBe(ISSUER_URL);
    expect(payload.sub).toBe(TEST_SUB);
    expect(payload.aud).toBe('sts.amazonaws.com');
  });

  it('iat / nbf / exp / jti を正しく設定する', async () => {
    const key = await generateTestKey('kid-1', 1_700_000_000);
    const env = makeEnv({ privateKeys: [key.privateJwk], sub: TEST_SUB });

    const before = Math.floor(Date.now() / 1000);
    const jwt = await issueStsWebIdentityToken(env);
    const after = Math.floor(Date.now() / 1000);
    const { payload } = decodeJwt(jwt);

    expect(typeof payload.iat).toBe('number');
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
    expect(payload.nbf).toBe(payload.iat);
    expect(payload.exp).toBe((payload.iat as number) + 60);
    // jti は UUID v4 形式
    expect(payload.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('呼び出し毎に新しい jti を発行する (3 連続呼び出しで全て異なる)', async () => {
    const key = await generateTestKey('kid-1', 1_700_000_000);
    const env = makeEnv({ privateKeys: [key.privateJwk], sub: TEST_SUB });

    const [a, b, c] = await Promise.all([
      issueStsWebIdentityToken(env),
      issueStsWebIdentityToken(env),
      issueStsWebIdentityToken(env),
    ]);
    const jtis = [a, b, c].map((jwt) => decodeJwt(jwt).payload.jti);

    expect(new Set(jtis).size).toBe(3);
  });

  it('multi-kid シナリオ: 最新 created_at の鍵で署名する', async () => {
    const older = await generateTestKey('kid-old', 1_700_000_000);
    const newer = await generateTestKey('kid-new', 1_700_001_000);
    // 配列順は古い→新しいでも新しい→古いでも同じ結果になるはず (createdAt で並べ替える設計)。
    const env = makeEnv({ privateKeys: [older.privateJwk, newer.privateJwk], sub: TEST_SUB });

    const jwt = await issueStsWebIdentityToken(env);
    const { header } = decodeJwt(jwt);
    expect(header.kid).toBe('kid-new');

    // 新鍵の public で verify 成功、旧鍵の public では失敗することを確認。
    const newerPub = await importJWK(newer.publicJwk, 'RS256');
    await expect(jwtVerify(jwt, newerPub, { issuer: ISSUER_URL, audience: 'sts.amazonaws.com' }))
      .resolves.toBeDefined();
    const olderPub = await importJWK(older.publicJwk, 'RS256');
    await expect(jwtVerify(jwt, olderPub, { issuer: ISSUER_URL, audience: 'sts.amazonaws.com' }))
      .rejects.toThrow();
  });

  it('OIDC_SUB 未設定でエラー', async () => {
    const key = await generateTestKey('kid-1', 1_700_000_000);
    const env = makeEnv({ privateKeys: [key.privateJwk] });
    await expect(issueStsWebIdentityToken(env)).rejects.toThrow(/OIDC_SUB is required/);
  });

  it('OIDC_PRIVATE_KEYS_JWK 未設定でエラー', async () => {
    const env = { WORKER_PUBLIC_URL: ISSUER_HOST, OIDC_SUB: TEST_SUB } as unknown as Env;
    await expect(issueStsWebIdentityToken(env)).rejects.toThrow(/OIDC_PRIVATE_KEYS_JWK/);
  });

  it('OIDC_PRIVATE_KEYS_JWK が不正な JSON でエラー', async () => {
    const env = {
      OIDC_PRIVATE_KEYS_JWK: 'not-a-json',
      WORKER_PUBLIC_URL: ISSUER_HOST,
      OIDC_SUB: TEST_SUB,
    } as unknown as Env;
    await expect(issueStsWebIdentityToken(env)).rejects.toThrow(/not valid JSON/);
  });

  it('OIDC_PRIVATE_KEYS_JWK の keys が空配列でエラー', async () => {
    const env = {
      OIDC_PRIVATE_KEYS_JWK: '{"keys":[]}',
      WORKER_PUBLIC_URL: ISSUER_HOST,
      OIDC_SUB: TEST_SUB,
    } as unknown as Env;
    await expect(issueStsWebIdentityToken(env)).rejects.toThrow(/non-empty keys array/);
  });

  it('WORKER_PUBLIC_URL 未設定でエラー', async () => {
    const key = await generateTestKey('kid-1', 1_700_000_000);
    const env = {
      OIDC_PRIVATE_KEYS_JWK: JSON.stringify({ keys: [key.privateJwk] }),
      OIDC_SUB: TEST_SUB,
    } as unknown as Env;
    await expect(issueStsWebIdentityToken(env)).rejects.toThrow(/WORKER_PUBLIC_URL is required/);
  });
});

describe('buildJwks', () => {
  it('公開鍵のみ返し private parameter (d/p/q/dp/dq/qi) を漏らさない', async () => {
    const key = await generateTestKey('kid-1', 1_700_000_000);
    const env = makeEnv({ privateKeys: [key.privateJwk], sub: TEST_SUB });

    const jwks = await buildJwks(env);
    expect(jwks.keys).toHaveLength(1);
    const k = jwks.keys[0]!;
    expect(k.kid).toBe('kid-1');
    expect(k.kty).toBe('RSA');
    expect(k.use).toBe('sig');
    expect(k.alg).toBe('RS256');
    expect('n' in k).toBe(true);
    expect('e' in k).toBe(true);
    // private fields は出ない
    for (const forbidden of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(forbidden in k).toBe(false);
    }
  });

  it('multi-kid: 配列全件 (新旧両方) を返す', async () => {
    const older = await generateTestKey('kid-old', 1_700_000_000);
    const newer = await generateTestKey('kid-new', 1_700_001_000);
    const env = makeEnv({ privateKeys: [older.privateJwk, newer.privateJwk], sub: TEST_SUB });

    const jwks = await buildJwks(env);
    const kids = jwks.keys.map((k) => k.kid).sort();
    expect(kids).toEqual(['kid-new', 'kid-old']);
  });
});

describe('buildDiscoveryDocument', () => {
  it('必須フィールドを含む', () => {
    const doc = buildDiscoveryDocument(ISSUER_URL);
    expect(doc.issuer).toBe(ISSUER_URL);
    expect(doc.jwks_uri).toBe(`${ISSUER_URL}/.well-known/jwks.json`);
    expect(doc.id_token_signing_alg_values_supported).toEqual(['RS256']);
    expect(doc.response_types_supported).toEqual(['id_token']);
    expect(doc.subject_types_supported).toEqual(['public']);
  });

  it('末尾スラッシュを除去する', () => {
    const doc = buildDiscoveryDocument(`${ISSUER_URL}///`);
    expect(doc.issuer).toBe(ISSUER_URL);
    expect(doc.jwks_uri).toBe(`${ISSUER_URL}/.well-known/jwks.json`);
  });
});

describe('deriveIssuerUrl', () => {
  it('WORKER_PUBLIC_URL から /oidc を付与した URL を返す', () => {
    const env = { WORKER_PUBLIC_URL: ISSUER_HOST } as unknown as Env;
    expect(deriveIssuerUrl(env)).toBe(ISSUER_URL);
  });

  it('末尾スラッシュ付きでも正規化する', () => {
    const env = { WORKER_PUBLIC_URL: `${ISSUER_HOST}///` } as unknown as Env;
    expect(deriveIssuerUrl(env)).toBe(ISSUER_URL);
  });
});

describe('module export 制限', () => {
  it('signOidcToken は module から export されていない (HTTP route 誤 expose 防止)', async () => {
    // 動的 import で namespace を取り、signOidcToken が export されていないことを確認。
    const mod = await import('./oidc-issuer.js');
    expect('signOidcToken' in mod).toBe(false);
    // 公開 API は限定されている
    expect('issueStsWebIdentityToken' in mod).toBe(true);
    expect('buildJwks' in mod).toBe(true);
    expect('buildDiscoveryDocument' in mod).toBe(true);
    expect('deriveIssuerUrl' in mod).toBe(true);
  });
});
