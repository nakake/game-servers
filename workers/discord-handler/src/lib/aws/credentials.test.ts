// credentials.ts のテスト。
//
// oidc-issuer (JWT 発行) と postDiscordWebhookMessage (通知) は module mock し、
// KV と fetch だけ stub することで「OIDC 経路の挙動」と「static fallback の有無」を
// 直接 assert する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// hoist-safe な module mock。実装側より先に hoist される。
vi.mock('../auth/oidc-issuer.js', () => ({
  issueStsWebIdentityToken: vi.fn(),
}));
vi.mock('../discord/webhook.js', () => ({
  postDiscordWebhookMessage: vi.fn(async () => true),
}));

import { issueStsWebIdentityToken } from '../auth/oidc-issuer.js';
import { postDiscordWebhookMessage } from '../discord/webhook.js';

import { _resetInflight, getAwsCredentials, OidcCredentialError } from './credentials.js';
import type { Env } from '../../env.js';

const ROLE_ARN = 'arn:aws:iam::123456789012:role/gs-worker-oidc-role';
const STS_URL = 'https://sts.ap-northeast-1.amazonaws.com/';

// ---- mocks / stubs ----

interface KvStoreEntry {
  value: string;
  expirationTtl?: number;
}

interface MockKv extends KVNamespace {
  _store: Map<string, KvStoreEntry>;
  _putFails: boolean;
}

function createKv({ putFails = false }: { putFails?: boolean } = {}): MockKv {
  const store = new Map<string, KvStoreEntry>();
  const kv = {
    _store: store,
    _putFails: putFails,
    async get(key: string): Promise<string | null> {
      return store.get(key)?.value ?? null;
    },
    async put(
      key: string,
      value: string,
      opts?: KVNamespacePutOptions,
    ): Promise<void> {
      if (kv._putFails && key.startsWith('aws-creds:')) {
        throw new Error('KV put failed (test injection)');
      }
      const entry: KvStoreEntry = { value };
      if (opts?.expirationTtl !== undefined) entry.expirationTtl = opts.expirationTtl;
      store.set(key, entry);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  } as unknown as MockKv;
  return kv;
}

function makeEnv(overrides: Partial<Env> & { kv?: MockKv } = {}): Env {
  const kv = overrides.kv ?? createKv();
  return {
    AWS_AUTH_MODE: 'oidc',
    AWS_OIDC_ROLE_ARN: ROLE_ARN,
    AWS_ACCESS_KEY_ID: 'AKIASTATIC',
    AWS_SECRET_ACCESS_KEY: 'secretstatic',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/test/x',
    SERVER_STATE: kv,
    ...overrides,
  } as unknown as Env;
}

function makeCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    // 全 waitUntil promise が settle するまで待機 (新たに waitUntil が呼ばれる
    // 連鎖にも対応するため複数 round 回す)。
    settled: async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0);
        await Promise.allSettled(batch);
      }
    },
  };
}

function stsXmlSuccess(expirationIso: string): string {
  return `<?xml version="1.0"?>
<AssumeRoleWithWebIdentityResponse>
  <AssumeRoleWithWebIdentityResult>
    <Credentials>
      <AccessKeyId>ASIATESTSESSION</AccessKeyId>
      <SecretAccessKey>session-secret-12345</SecretAccessKey>
      <SessionToken>SESSION/TOKEN/VERY-LONG</SessionToken>
      <Expiration>${expirationIso}</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`;
}

function stsXmlError(code: string, messageWithArn: string): string {
  return `<?xml version="1.0"?>
<ErrorResponse>
  <Error>
    <Type>Sender</Type>
    <Code>${code}</Code>
    <Message>${messageWithArn}</Message>
  </Error>
  <RequestId>req-${code}</RequestId>
</ErrorResponse>`;
}

function isoFromNow(secondsAhead: number): string {
  return new Date(Date.now() + secondsAhead * 1000).toISOString();
}

beforeEach(() => {
  _resetInflight();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.mocked(issueStsWebIdentityToken).mockReset().mockResolvedValue('test.jwt.token');
  vi.mocked(postDiscordWebhookMessage).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// =============================================================================
// 1. static mode
// =============================================================================

describe('getAwsCredentials — static mode (後方互換)', () => {
  it('AWS_AUTH_MODE 未設定 → static credentials を即 return、KV / STS / JWT を一切呼ばない', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    // makeEnv の default は 'oidc'。base env を作って AWS_AUTH_MODE プロパティだけ delete することで
    // exactOptionalPropertyTypes 配下でも「未設定」を表現する。
    const env = makeEnv({ kv });
    delete (env as { AWS_AUTH_MODE?: 'static' | 'oidc' }).AWS_AUTH_MODE;
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds).toEqual({
      accessKeyId: 'AKIASTATIC',
      secretAccessKey: 'secretstatic',
    });
    expect(creds.sessionToken).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(issueStsWebIdentityToken).not.toHaveBeenCalled();
    expect(kv._store.size).toBe(0);
  });

  it('AWS_AUTH_MODE = "static" でも同じ static 経路を取る', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const env = makeEnv({ AWS_AUTH_MODE: 'static' });
    const { ctx, settled } = makeCtx();
    const creds = await getAwsCredentials(env, ctx);
    await settled();
    expect(creds.accessKeyId).toBe('AKIASTATIC');
    expect(issueStsWebIdentityToken).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 2. oidc mode: cache hit
// =============================================================================

describe('getAwsCredentials — oidc mode cache', () => {
  it('cache hit (expiration > now + 60s) で STS / JWT を呼ばずに即 return', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    const future = Math.floor(Date.now() / 1000) + 600; // 10 分後
    kv._store.set('aws-creds:cache', {
      value: JSON.stringify({
        accessKeyId: 'ASIACACHED',
        secretAccessKey: 'cached-secret',
        sessionToken: 'cached-token',
        expiration: future,
      }),
    });
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIACACHED');
    expect(creds.sessionToken).toBe('cached-token');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(issueStsWebIdentityToken).not.toHaveBeenCalled();
  });

  it('cache expiration が残 60s 以内なら expired 扱いで再取得する', async () => {
    const expIso = isoFromNow(2700);
    const fetchMock = vi.fn(async () => new Response(stsXmlSuccess(expIso), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    const nearExp = Math.floor(Date.now() / 1000) + 30; // 残 30s
    kv._store.set('aws-creds:cache', {
      value: JSON.stringify({
        accessKeyId: 'ASIASTALE',
        secretAccessKey: 'stale',
        sessionToken: 'stale',
        expiration: nearExp,
      }),
    });
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIATESTSESSION'); // 新 STS の戻り値
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 3. oidc mode: STS 正常系
// =============================================================================

describe('getAwsCredentials — oidc mode STS 呼び出し', () => {
  it('cache miss → JWT 発行 → STS で credentials 取得 → KV put (TTL は負方向 jitter)', async () => {
    const expSec = Math.floor(Date.now() / 1000) + 900; // 15 分
    const expIso = new Date(expSec * 1000).toISOString();
    const fetchMock = vi.fn(async () => new Response(stsXmlSuccess(expIso), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIATESTSESSION');
    expect(creds.sessionToken).toBe('SESSION/TOKEN/VERY-LONG');
    expect(issueStsWebIdentityToken).toHaveBeenCalledTimes(1);
    expect(issueStsWebIdentityToken).toHaveBeenCalledWith(env);

    // fetch URL / method / body の最低限を assert
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall as unknown as [string, RequestInit];
    expect(url).toBe(STS_URL);
    expect(init.method).toBe('POST');
    const body = (init.body as string).split('&').reduce<Record<string, string>>((acc, kv) => {
      const [k, v] = kv.split('=');
      if (k !== undefined) acc[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
      return acc;
    }, {});
    expect(body.Action).toBe('AssumeRoleWithWebIdentity');
    expect(body.RoleArn).toBe(ROLE_ARN);
    expect(body.WebIdentityToken).toBe('test.jwt.token');
    expect(body.DurationSeconds).toBe('900');
    expect(body.RoleSessionName).toMatch(/^oidc-[0-9a-f]{8}$/);

    // KV put の TTL が負方向 jitter 範囲内: (expSec - now - 60 - jitter)、最大 = expSec - now - 60
    const cached = kv._store.get('aws-creds:cache');
    expect(cached).toBeDefined();
    const stored = JSON.parse(cached!.value) as { accessKeyId: string; expiration: number };
    expect(stored.accessKeyId).toBe('ASIATESTSESSION');
    expect(stored.expiration).toBe(expSec);

    const now = Math.floor(Date.now() / 1000);
    const maxTtl = expSec - now - 60; // 60s 早め refresh
    const minTtl = Math.max(60, maxTtl - 30); // -30s jitter or KV minimum
    expect(cached!.expirationTtl).toBeDefined();
    expect(cached!.expirationTtl!).toBeGreaterThanOrEqual(minTtl - 1); // -1 で時計差を許容
    expect(cached!.expirationTtl!).toBeLessThanOrEqual(maxTtl);
  });
});

// =============================================================================
// 4. oidc mode: failure handling
// =============================================================================

describe('getAwsCredentials — oidc mode failure', () => {
  it('STS 4xx → OidcCredentialError throw、static credentials へ fallback しない (絶対)', async () => {
    const errorXml = stsXmlError(
      'AccessDenied',
      `User: ${ROLE_ARN} is not authorized to perform: sts:AssumeRoleWithWebIdentity on resource arn:aws:iam::123456789012:role/gs-worker-oidc-role`,
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(errorXml, { status: 403 })));
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    await expect(getAwsCredentials(env, ctx)).rejects.toBeInstanceOf(OidcCredentialError);
    await settled();

    // throw 直前に Discord 通知が 1 回 (ctx.waitUntil 経由)
    const calls = vi.mocked(postDiscordWebhookMessage).mock.calls;
    expect(calls).toHaveLength(1);
    const content = calls[0]![1].content!;
    expect(content).toContain('AccessDenied');
    expect(content).toContain('HTTP 403');

    // ARN / account ID をエコーしないこと (Message body が混入していないこと)
    expect(content).not.toContain(ROLE_ARN);
    expect(content).not.toContain('123456789012');
    expect(content).not.toContain('arn:aws:iam');
  });

  it('STS network 失敗 → NetworkError として throw + 通知、static fallback しない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    await expect(getAwsCredentials(env, ctx)).rejects.toMatchObject({
      code: 'NetworkError',
      status: 0,
    });
    await settled();
    expect(postDiscordWebhookMessage).toHaveBeenCalledTimes(1);
    expect(postDiscordWebhookMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: expect.stringContaining('NetworkError') as unknown }),
    );
  });

  it('JWT 発行失敗 (OIDC_SUB / private key 不正) → JwtIssueFailed throw、STS は呼ばない', async () => {
    vi.mocked(issueStsWebIdentityToken).mockRejectedValueOnce(
      new Error('OIDC_SUB is required'),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    await expect(getAwsCredentials(env, ctx)).rejects.toMatchObject({
      code: 'JwtIssueFailed',
    });
    await settled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(postDiscordWebhookMessage).toHaveBeenCalledTimes(1);
  });

  it('AWS_OIDC_ROLE_ARN 未設定 → MissingRoleArn throw、JWT / STS は呼ばない', async () => {
    const env = makeEnv();
    delete (env as { AWS_OIDC_ROLE_ARN?: string }).AWS_OIDC_ROLE_ARN;
    const { ctx, settled } = makeCtx();
    await expect(getAwsCredentials(env, ctx)).rejects.toMatchObject({ code: 'MissingRoleArn' });
    await settled();
    expect(issueStsWebIdentityToken).not.toHaveBeenCalled();
  });

  it('KV put 失敗 → credentials は呼び出し側に return + Discord 通知 (silent degradation 防止)', async () => {
    const expIso = isoFromNow(900);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stsXmlSuccess(expIso), { status: 200 })),
    );
    const kv = createKv({ putFails: true });
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIATESTSESSION'); // throw せず credentials は返る
    expect(postDiscordWebhookMessage).toHaveBeenCalledTimes(1);
    expect(postDiscordWebhookMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: expect.stringContaining('KV cache put 失敗') as unknown,
      }),
    );
  });

  it('STS 連続失敗時、Discord 通知は 1h suppress で 1 回のみ', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stsXmlError('InternalFailure', 'x'), { status: 500 })),
    );
    const kv = createKv();
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    // 1 回目: 通知される
    await expect(getAwsCredentials(env, ctx)).rejects.toBeInstanceOf(OidcCredentialError);
    await settled();
    // 2 回目: suppress (notif-suppress: の KV エントリで 1h 抑制)
    await expect(getAwsCredentials(env, ctx)).rejects.toBeInstanceOf(OidcCredentialError);
    await settled();

    expect(postDiscordWebhookMessage).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 5. in-flight Promise dedup
// =============================================================================

describe('getAwsCredentials — in-flight Promise dedup', () => {
  it('同 invocation で並列 5 呼び出し → JWT / STS が 1 回のみ', async () => {
    const expIso = isoFromNow(900);
    const fetchMock = vi.fn(async () => new Response(stsXmlSuccess(expIso), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    const results = await Promise.all([
      getAwsCredentials(env, ctx),
      getAwsCredentials(env, ctx),
      getAwsCredentials(env, ctx),
      getAwsCredentials(env, ctx),
      getAwsCredentials(env, ctx),
    ]);
    await settled();

    expect(results).toHaveLength(5);
    for (const c of results) expect(c.accessKeyId).toBe('ASIATESTSESSION');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(issueStsWebIdentityToken).toHaveBeenCalledTimes(1);
  });

  it('in-flight Promise reject 後、再呼び出しで Map が空 → 2 回目の STS 試行ができる (cleanup 担保)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(stsXmlError('Throttling', 'x'), { status: 429 }))
      .mockResolvedValueOnce(new Response(stsXmlSuccess(isoFromNow(900)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    await expect(getAwsCredentials(env, ctx)).rejects.toBeInstanceOf(OidcCredentialError);
    await settled();
    // 2 回目: 別 promise で再試行できる
    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIATESTSESSION');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// 6. negative jitter / TTL 計算
// =============================================================================

describe('getAwsCredentials — KV cache TTL 計算', () => {
  it('jitter は負方向のみ: TTL <= expiration - now - 60、常に 60 以上 (KV 下限)', async () => {
    // 1000 回サンプルして範囲を確認
    const samples: number[] = [];
    const env = makeEnv();
    const expSec = Math.floor(Date.now() / 1000) + 900;
    const expIso = new Date(expSec * 1000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stsXmlSuccess(expIso), { status: 200 })),
    );

    for (let i = 0; i < 50; i++) {
      const kv = createKv();
      const envI = makeEnv({ kv });
      const { ctx, settled } = makeCtx();
      _resetInflight();
      await getAwsCredentials(envI, ctx);
      await settled();
      const cached = kv._store.get('aws-creds:cache');
      samples.push(cached!.expirationTtl!);
      void env;
    }

    // 負方向 jitter: TTL <= (expSec - now - 60) = 約 840
    // 結果として TTL は 811..840 の範囲 (jitter 0..30)、KV 最小 60 でガード
    const now = Math.floor(Date.now() / 1000);
    const maxTtl = expSec - now - 60;
    for (const ttl of samples) {
      expect(ttl).toBeGreaterThanOrEqual(60);
      expect(ttl).toBeLessThanOrEqual(maxTtl + 1); // +1 で時計差許容
    }
    // 少なくとも 1 つは max よりも小さい (= jitter が効いている) ことを確認
    expect(samples.some((t) => t < maxTtl)).toBe(true);
  });
});
