// credentials.ts のテスト。
//
// oidc-issuer (JWT 発行) と postDiscordWebhookMessage (通知) は module mock し、
// KV と fetch だけ stub することで OIDC 経路の挙動を直接 assert する。
// 旧 static 経路 (AWS_AUTH_MODE 分岐 + IAM Access Key) は Step 7 で削除済。
//
// 再試行の backoff と 1 試行のタイムアウトは fake timers で進める。
// 実時間を待たずに「3 回試行」「abort 3 連続」まで到達できる。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

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

// 残り secondsAhead 秒の cache を仕込む (残り時間の境界テスト用)。
function seedCache(
  kv: MockKv,
  secondsAhead: number,
  creds: Partial<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> = {},
): void {
  kv._store.set('aws-creds:cache', {
    value: JSON.stringify({
      accessKeyId: 'ASIACACHED',
      secretAccessKey: 'cached-secret',
      sessionToken: 'cached-token',
      ...creds,
      expiration: Math.floor(Date.now() / 1000) + secondsAhead,
    }),
  });
}

function makeEnv(overrides: Partial<Env> & { kv?: MockKv } = {}): Env {
  const kv = overrides.kv ?? createKv();
  return {
    AWS_OIDC_ROLE_ARN: ROLE_ARN,
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

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

// レスポンスが返らないまま signal の abort を待つ fetch mock (タイムアウト検証用)。
function hangingFetchMock(): Mock {
  return vi.fn((_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (signal == null) throw new Error('signal is not set');
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(abortError()));
    });
  });
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
  // backoff と 1 試行のタイムアウトを実時間待ちせずに進める。
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.mocked(issueStsWebIdentityToken).mockReset().mockResolvedValue('test.jwt.token');
  vi.mocked(postDiscordWebhookMessage).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// =============================================================================
// 1. oidc cache
// =============================================================================
// 旧 static 経路 (AWS_AUTH_MODE 分岐) のテストは Step 7 (2026-05-24) で削除済。
// 現状は OIDC 専用 = AWS_AUTH_MODE / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY を持たない。

describe('getAwsCredentials — oidc cache', () => {
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

  const BROKEN_EXPIRATIONS: Array<[string, Record<string, unknown>]> = [
    [
      '欠落',
      { accessKeyId: 'ASIACACHED', secretAccessKey: 'cached-secret', sessionToken: 'cached-token' },
    ],
    [
      '非数値',
      {
        accessKeyId: 'ASIACACHED',
        secretAccessKey: 'cached-secret',
        sessionToken: 'cached-token',
        expiration: 'invalid',
      },
    ],
  ];

  it.each(BROKEN_EXPIRATIONS)(
    'cache の expiration が%s なら期限切れ扱いで、STS 失敗時は throw する',
    async (_label, broken) => {
      const fetchMock = vi.fn(
        async () => new Response(stsXmlError('AccessDenied', 'x'), { status: 403 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const kv = createKv();
      kv._store.set('aws-creds:cache', { value: JSON.stringify(broken) });
      const env = makeEnv({ kv });
      const { ctx, settled } = makeCtx();

      await expect(getAwsCredentials(env, ctx)).rejects.toBeInstanceOf(OidcCredentialError);
      await settled();

      // 更新窓 (残り 61〜420s) に分類されていると、壊れた cache をそのまま返してしまう。
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(postDiscordWebhookMessage).toHaveBeenCalledTimes(1);
    },
  );
});

// =============================================================================
// 1b. 早期更新 (更新窓) と残り時間の境界
// =============================================================================

describe('getAwsCredentials — 早期更新 (更新窓)', () => {
  it('残り 421s は cache を返し、fetch も JWT も呼ばない', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    seedCache(kv, 421);
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIACACHED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(issueStsWebIdentityToken).not.toHaveBeenCalled();
  });

  it('残り 420s は更新窓に入り、STS を 1 回試す', async () => {
    const fetchMock = vi.fn(
      async () => new Response(stsXmlSuccess(isoFromNow(900)), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    seedCache(kv, 420);
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIATESTSESSION'); // 更新後の credentials
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('残り 61s は更新窓に入り、失敗したら cache を返す', async () => {
    const fetchMock = vi.fn(
      async () => new Response(stsXmlError('InternalFailure', 'x'), { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    seedCache(kv, 61);
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIACACHED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postDiscordWebhookMessage).not.toHaveBeenCalled();
  });

  it('残り 60s は期限切れ扱いで、失敗したら throw する', async () => {
    const fetchMock = vi.fn(
      async () => new Response(stsXmlError('AccessDenied', 'x'), { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    seedCache(kv, 60);
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    await expect(getAwsCredentials(env, ctx)).rejects.toBeInstanceOf(OidcCredentialError);
    await settled();

    // 403 は再試行対象外なので 1 回で失敗する
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postDiscordWebhookMessage).toHaveBeenCalledTimes(1);
  });

  it('更新窓で STS が 500 → cache を返し、throw も通知もしない (fetch 1 回)', async () => {
    const errorXml = stsXmlError('InternalFailure', `role ${ROLE_ARN} failed`);
    const fetchMock = vi.fn(async () => new Response(errorXml, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    seedCache(kv, 300);
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIACACHED');
    expect(creds.sessionToken).toBe('cached-token');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 更新窓は 1 回だけ
    expect(postDiscordWebhookMessage).not.toHaveBeenCalled();

    // warn はエラーコードのみ (ARN を含む Message は出さない)
    const warnMock = vi.mocked(console.warn);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]).toContain('InternalFailure');
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain('arn:aws:iam');
  });

  it('更新窓で STS が成功 → 新しい credentials を返し、KV に put する', async () => {
    const expSec = Math.floor(Date.now() / 1000) + 900;
    const expIso = new Date(expSec * 1000).toISOString();
    const fetchMock = vi.fn(async () => new Response(stsXmlSuccess(expIso), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    seedCache(kv, 300);
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIATESTSESSION');
    const cached = kv._store.get('aws-creds:cache');
    expect(cached).toBeDefined();
    const stored = JSON.parse(cached!.value) as { accessKeyId: string; expiration: number };
    expect(stored.accessKeyId).toBe('ASIATESTSESSION');
    expect(stored.expiration).toBe(expSec);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('更新窓で STS がハング → 3 秒で abort して cache を返す', async () => {
    const fetchMock = hangingFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    seedCache(kv, 300);
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    let settledState: 'pending' | 'done' = 'pending';
    const promise = getAwsCredentials(env, ctx).then((creds) => {
      settledState = 'done';
      return creds;
    });

    // microtask を流して 1 試行目の fetch まで進める。
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 更新窓のタイムアウトは 3 秒。3 秒未満ではまだ abort しない。
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settledState).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    const creds = await promise;
    await settled();

    expect(creds.accessKeyId).toBe('ASIACACHED');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 更新窓は 1 試行のみ
    expect(postDiscordWebhookMessage).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls[0]).toContain('Timeout');
  });

  it('更新窓で KV put が失敗しても Discord 通知はしない (warn のみ)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(stsXmlSuccess(isoFromNow(900)), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv({ putFails: true });
    seedCache(kv, 300);
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIATESTSESSION'); // 更新後の credentials を返す
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 別 invocation と同時に更新した場合の KV 書き込み競合でも鳴り得るため、通知はしない。
    expect(postDiscordWebhookMessage).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toContain('KV cache put failed');
  });

  it('更新窓で JwtIssueFailed → cache を返す (通知なし)', async () => {
    vi.mocked(issueStsWebIdentityToken).mockRejectedValueOnce(
      new Error('OIDC_SUB is required'),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    seedCache(kv, 300);
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIACACHED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(postDiscordWebhookMessage).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls[0]).toContain('JwtIssueFailed');
  });

  it('更新窓で ParseError (200 だが XML が壊れている) → cache を返す (更新窓は 1 試行のみ)', async () => {
    const fetchMock = vi.fn(async () => new Response('<not-valid-xml', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    seedCache(kv, 300);
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    const creds = await getAwsCredentials(env, ctx);
    await settled();

    expect(creds.accessKeyId).toBe('ASIACACHED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postDiscordWebhookMessage).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls[0]).toContain('ParseError');
  });
});

// =============================================================================
// 2. STS 正常系
// =============================================================================

describe('getAwsCredentials — STS 呼び出し', () => {
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
// 2b. STS の再試行
// =============================================================================

describe('getAwsCredentials — STS の再試行', () => {
  it('525 のあと 200 なら成功する (fetch 2 回、通知 0 回)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(stsXmlError('InternalFailure', 'x'), { status: 525 }))
      .mockResolvedValueOnce(new Response(stsXmlSuccess(isoFromNow(900)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    const assertion = expect(getAwsCredentials(env, ctx)).resolves.toMatchObject({
      accessKeyId: 'ASIATESTSESSION',
    });
    // backoff (200ms × 2^n + jitter) を進める
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(issueStsWebIdentityToken).toHaveBeenCalledTimes(1); // JWT は再発行しない
    expect(postDiscordWebhookMessage).not.toHaveBeenCalled();
  });

  it('IDPCommunicationError (400) は一過性として再試行し、200 で成功する (fetch 2 回)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(stsXmlError('IDPCommunicationError', 'x'), { status: 400 }),
      )
      .mockResolvedValueOnce(new Response(stsXmlSuccess(isoFromNow(900)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    const assertion = expect(getAwsCredentials(env, ctx)).resolves.toMatchObject({
      accessKeyId: 'ASIATESTSESSION',
    });
    // backoff (200ms × 2^n + jitter) を進める
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postDiscordWebhookMessage).not.toHaveBeenCalled();
  });

  it('403 は再試行せず fetch 1 回で失敗する', async () => {
    const fetchMock = vi.fn(
      async () => new Response(stsXmlError('AccessDenied', 'x'), { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    await expect(getAwsCredentials(env, ctx)).rejects.toMatchObject({
      code: 'AccessDenied',
      status: 403,
    });
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fetch が返らず abort が 3 回続くと Timeout (status 0) で失敗する', async () => {
    const fetchMock = hangingFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    const assertion = expect(getAwsCredentials(env, ctx)).rejects.toMatchObject({
      code: 'Timeout',
      status: 0,
    });
    // 3 試行分のタイムアウト (3 / 5 / 8 秒) と backoff をまとめて進める
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(issueStsWebIdentityToken).toHaveBeenCalledTimes(1);
    expect(postDiscordWebhookMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('期限切れ経路のタイムアウトは 1 回目 3 秒 / 2 回目 5 秒 / 3 回目 8 秒', async () => {
    // backoff を 200 / 400ms に固定し、各試行の開始時刻を決定的にする。
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = hangingFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    let settledState: 'pending' | 'rejected' = 'pending';
    const assertion = expect(
      getAwsCredentials(env, ctx).catch((err: unknown) => {
        settledState = 'rejected';
        throw err;
      }),
    ).rejects.toMatchObject({ code: 'Timeout', status: 0 });

    // 1 試行目: 3 秒で abort する。まとめて進めると 3 / 3 / 3 秒でも通ってしまうため個別に見る。
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settledState).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(200); // abort → backoff → 2 試行目
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 2 試行目: 5 秒で abort する (3 秒ならここで 3 試行目に進んでしまう)。
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settledState).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(400); // abort → backoff → 3 試行目
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 3 試行目: 8 秒で abort し、最後の試行なので Timeout で失敗する。
    await vi.advanceTimersByTimeAsync(7_999);
    expect(settledState).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(postDiscordWebhookMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('5xx と abort が混ざっても総試行は 3 回で止まる', async () => {
    let calls = 0;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      calls++;
      if (calls === 2) {
        const signal = init?.signal;
        if (signal == null) throw new Error('signal is not set');
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(abortError()));
        });
      }
      return Promise.resolve(new Response(stsXmlError('InternalFailure', 'x'), { status: 525 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    const assertion = expect(getAwsCredentials(env, ctx)).rejects.toMatchObject({
      code: 'InternalFailure',
      status: 525,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('成功後・失敗後に未消化のタイマーが残らない (vi.getTimerCount() が 0)', async () => {
    // 成功: 525 → 200 (backoff を挟む)
    const okFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(stsXmlError('InternalFailure', 'x'), { status: 525 }))
      .mockResolvedValueOnce(new Response(stsXmlSuccess(isoFromNow(900)), { status: 200 }));
    vi.stubGlobal('fetch', okFetch);
    const okRun = makeCtx();
    const okAssertion = expect(getAwsCredentials(makeEnv(), okRun.ctx)).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await okAssertion;
    await okRun.settled();
    expect(vi.getTimerCount()).toBe(0);

    // 失敗: abort 3 回 (3 / 5 / 8 秒のタイムアウトを挟む)
    const hangFetch = hangingFetchMock();
    vi.stubGlobal('fetch', hangFetch);
    const failRun = makeCtx();
    const failAssertion = expect(getAwsCredentials(makeEnv(), failRun.ctx)).rejects.toMatchObject({
      code: 'Timeout',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await failAssertion;
    await failRun.settled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// =============================================================================
// 3. failure handling
// =============================================================================

describe('getAwsCredentials — failure', () => {
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

  it('STS network 失敗 → 3 回試行して NetworkError として throw + 通知', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = makeEnv();
    const { ctx, settled } = makeCtx();

    const assertion = expect(getAwsCredentials(env, ctx)).rejects.toMatchObject({
      code: 'NetworkError',
      status: 0,
    });
    // backoff (200ms × 2^n + jitter) を進める
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(3);
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

  // AWS_OIDC_ROLE_ARN 未設定の case は Step 7 で削除済 (env type で required string、
  // empty string ガードも削除)。Worker 起動時の binding 不備は wrangler 側で弾かれる前提。

  it('期限切れ経路で KV put 失敗 → credentials は呼び出し側に return + Discord 通知 (silent degradation 防止)', async () => {
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

  it('STS 連続失敗時、Discord 通知は 1h suppress で 1 回のみ (各呼び出しは 3 回試行)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(stsXmlError('InternalFailure', 'x'), { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    const env = makeEnv({ kv });
    const { ctx, settled } = makeCtx();

    // 1 回目: 3 回試行して失敗、通知される
    const first = expect(getAwsCredentials(env, ctx)).rejects.toBeInstanceOf(OidcCredentialError);
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    await settled();
    // 2 回目: 同様に 3 回試行して失敗、通知は suppress (notif-suppress: の KV エントリで 1h 抑制)
    const second = expect(getAwsCredentials(env, ctx)).rejects.toBeInstanceOf(OidcCredentialError);
    await vi.advanceTimersByTimeAsync(2_000);
    await second;
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(6);
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

  it('in-flight Promise reject 後、再呼び出しで dedup エントリが消える (cleanup 担保)', async () => {
    // 1 回目は再試行対象外の 403 で即失敗させる (429 だと 3 回試行になってしまう)。
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(stsXmlError('AccessDenied', 'x'), { status: 403 }))
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

  it('更新窓で同じ ctx から並行 5 呼び出し → fetch 1 回・通知 0 回', async () => {
    const fetchMock = vi.fn(
      async () => new Response(stsXmlError('InternalFailure', 'x'), { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    seedCache(kv, 300);
    const env = makeEnv({ kv });
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
    for (const c of results) expect(c.accessKeyId).toBe('ASIACACHED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(issueStsWebIdentityToken).toHaveBeenCalledTimes(1);
    expect(postDiscordWebhookMessage).not.toHaveBeenCalled();
  });

  it('別の ctx 同士では dedup されない (fetch は ctx の数だけ呼ばれる)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(stsXmlError('InternalFailure', 'x'), { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const kv = createKv();
    seedCache(kv, 300);
    const env = makeEnv({ kv });
    const first = makeCtx();
    const second = makeCtx();

    const results = await Promise.all([
      getAwsCredentials(env, first.ctx),
      getAwsCredentials(env, second.ctx),
    ]);
    await first.settled();
    await second.settled();

    for (const c of results) expect(c.accessKeyId).toBe('ASIACACHED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(issueStsWebIdentityToken).toHaveBeenCalledTimes(2);
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

// =============================================================================
// 7. OidcCredentialError.isTransient
// =============================================================================

describe('OidcCredentialError — isTransient', () => {
  // [code, status, expected]。Timeout / NetworkError、5xx (520 / 525 を含む)、429、
  // IDPCommunicationError (400)、ParseError が一過性。
  const CASES: Array<[string, number, boolean]> = [
    ['Timeout', 0, true],
    ['NetworkError', 0, true],
    ['InternalFailure', 500, true],
    ['InternalFailure', 525, true],
    ['Throttling', 429, true],
    ['IDPCommunicationError', 400, true],
    ['ParseError', 0, true],
    ['AccessDenied', 403, false],
    ['JwtIssueFailed', 0, false],
  ];

  it.each(CASES)('%s (HTTP %i) → isTransient %s', (code, status, expected) => {
    expect(new OidcCredentialError(code, status).isTransient).toBe(expected);
  });
});
