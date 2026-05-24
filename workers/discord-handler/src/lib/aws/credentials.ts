// AWS credential provider (Phase 5 Step 3)。
//
// AWS_AUTH_MODE の値で経路を切り替える:
//   - 'static' (default) → 旧 IAM Access Key を即 return (Phase 1〜4 経路、後方互換)
//   - 'oidc'             → OIDC JWT で STS AssumeRoleWithWebIdentity → 15min credentials
//
// OIDC 経路の動作 (docs/phase5-plan.md Step 3):
//   1. in-flight Promise dedup (同 isolate 内の並列 5 呼び出しを 1 本化)
//   2. KV `SERVER_STATE` `aws-creds:cache` 読み、`expiration > now + 60s` なら即 return
//   3. miss → issueStsWebIdentityToken で JWT 発行 (sub/aud/ttl=60s が module-private で固定)
//   4. STS regional endpoint (ap-northeast-1) に AssumeRoleWithWebIdentity POST (DurationSeconds=900)
//   5. XML から AccessKeyId / SecretAccessKey / SessionToken / Expiration を抽出
//   6. KV put TTL = (expiration - now - 60) - random(0..30)  ★負方向 jitter のみ
//      ctx.waitUntil で fire-and-forget、credentials は即 return
//
// Sentinel + 安全設計:
//   - oidc mode で STS / JWT / parse 失敗 → **絶対に static fallback しない**。OidcCredentialError を throw
//   - STS error の Code は出力 (Discord 通知に流す)、Message は ARN/account ID を含む可能性があるため捨てる
//   - JWT は log / 通知に絶対出力しない (signOidcToken の戻り値を toString 経由でも漏らさない)
//   - 全 OidcCredentialError は Phase 4 webhook に 1h 1 回まで通知 (notif-suppress)
//   - KV put 失敗 → credentials は return、別経路で Discord に 1h 1 回通知 (silent degradation 防止)
//
// 関連:
//   - lib/auth/oidc-issuer.ts: JWT 発行 (issueStsWebIdentityToken)
//   - lib/state/notif-suppress.ts: 1h 1 回通知の TTL guard
//   - lib/discord/webhook.ts: Phase 4 で導入した webhook poster
//   - lib/aws/client.ts: AwsCredentials 型 (sessionToken オプショナル受け入れ済)

import { issueStsWebIdentityToken } from '../auth/oidc-issuer.js';
import { postDiscordWebhookMessage } from '../discord/webhook.js';
import { shouldNotify } from '../state/notif-suppress.js';

import type { AwsCredentials } from './client.js';
import type { Env } from '../../env.js';

export class OidcCredentialError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(`OIDC credential error: ${code} (HTTP ${status})`);
    this.name = 'OidcCredentialError';
  }
}

interface CachedCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: number; // UNIX seconds (epoch)
}

const CACHE_KEY = 'aws-creds:cache';
const STS_REGION = 'ap-northeast-1';
const STS_API_VERSION = '2011-06-15';
const STS_DURATION_SECONDS = 900;
const CACHE_EARLY_REFRESH_SECONDS = 60;
const CACHE_NEGATIVE_JITTER_SECONDS = 30;
const KV_TTL_MINIMUM_SECONDS = 60;
const SUPPRESS_TTL_SECONDS = 3600;
const SUPPRESS_KEY_OIDC_FAIL = 'oidc-credential-fail';
const SUPPRESS_KEY_KV_PUT_FAIL = 'oidc-cache-kv-put-fail';

// module-scope in-flight Promise dedup。
// 並列呼び出しを 1 本に絞ることで STS 呼び出し回数を最小化する。
// finally で必ず削除して reject 後の永久 dedup を防ぐ (test で担保)。
const inflight = new Map<string, Promise<AwsCredentials>>();

// テスト用 reset。production code からは呼ばない。
export function _resetInflight(): void {
  inflight.clear();
}

// AWS API 呼び出しの直前に呼ぶ。credentials は AwsApiClient コンストラクタに渡す。
export async function getAwsCredentials(
  env: Env,
  ctx: ExecutionContext,
): Promise<AwsCredentials> {
  if (env.AWS_AUTH_MODE !== 'oidc') {
    // 後方互換: static 経路を即 return。KV / STS には触れない。
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    };
  }

  // oidc 経路: 単一 cache key を共有するため dedup key も固定。
  const dedupKey = 'sts';
  const existing = inflight.get(dedupKey);
  if (existing !== undefined) return existing;

  // IIFE で promise を作り、finally で Map cleanup を保証する。
  // 元 promise を inflight.set + return することで dedup の 2 回目以降も同じ promise を共有。
  const promise = (async () => {
    try {
      return await fetchOidcCredentials(env, ctx);
    } finally {
      inflight.delete(dedupKey);
    }
  })();
  inflight.set(dedupKey, promise);
  return promise;
}

async function fetchOidcCredentials(
  env: Env,
  ctx: ExecutionContext,
): Promise<AwsCredentials> {
  // 1. KV cache hit
  const cached = await readCache(env);
  if (cached !== undefined) return toAwsCredentials(cached);

  // 2. cache miss → STS AssumeRoleWithWebIdentity
  if (env.AWS_OIDC_ROLE_ARN === undefined || env.AWS_OIDC_ROLE_ARN === '') {
    await notifyOidcFailure(env, ctx, 'MissingRoleArn', 0);
    throw new OidcCredentialError('MissingRoleArn', 0);
  }

  let token: string;
  try {
    token = await issueStsWebIdentityToken(env);
  } catch (_err) {
    // JWT 発行失敗 = OIDC_SUB 未設定 / private key 不正 / etc. の config 不備。
    // 詳細は console (内部 log) に残し、Discord には code のみ流す。
    await notifyOidcFailure(env, ctx, 'JwtIssueFailed', 0);
    throw new OidcCredentialError('JwtIssueFailed', 0);
  }

  let creds: CachedCreds;
  try {
    creds = await callAssumeRoleWithWebIdentity(env.AWS_OIDC_ROLE_ARN, token);
  } catch (err) {
    if (err instanceof OidcCredentialError) {
      await notifyOidcFailure(env, ctx, err.code, err.status);
      throw err;
    }
    await notifyOidcFailure(env, ctx, 'Unknown', 0);
    throw new OidcCredentialError('Unknown', 0);
  }

  // 3. KV put は fire-and-forget。credentials は呼び出し側に即 return。
  // ctx.waitUntil で背景化することで cache write の失敗が caller を block しない。
  ctx.waitUntil(writeCache(env, ctx, creds));

  return toAwsCredentials(creds);
}

async function readCache(env: Env): Promise<CachedCreds | undefined> {
  const raw = await env.SERVER_STATE.get(CACHE_KEY);
  if (raw === null) return undefined;
  let parsed: CachedCreds;
  try {
    parsed = JSON.parse(raw) as CachedCreds;
  } catch {
    // 壊れた cache は無視して再取得する。意図的に warn は出さない (eventual consistency 中の
    // 半端な値を踏むケースが起こり得るが、再取得で復旧する)。
    return undefined;
  }
  const now = Math.floor(Date.now() / 1000);
  // 残 60s 以下なら expired 扱い (race を避けるため早めに refresh)
  if (parsed.expiration <= now + CACHE_EARLY_REFRESH_SECONDS) return undefined;
  return parsed;
}

async function writeCache(
  env: Env,
  ctx: ExecutionContext,
  creds: CachedCreds,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // 負方向 jitter のみ: より早く refresh する側に振る。
  // 正方向に振ると expiration 60s 未満の credentials を cache から返す race を生む (決定 4)。
  const jitter = Math.floor(Math.random() * CACHE_NEGATIVE_JITTER_SECONDS);
  const rawTtl = creds.expiration - now - CACHE_EARLY_REFRESH_SECONDS - jitter;
  // KV TTL 最小値は 60s。それより短いと put が ValidationException で落ちる。
  const ttl = Math.max(KV_TTL_MINIMUM_SECONDS, rawTtl);

  try {
    await env.SERVER_STATE.put(CACHE_KEY, JSON.stringify(creds), { expirationTtl: ttl });
  } catch (err) {
    // KV put 失敗は致命的でない (credentials は呼び出し側に return 済、次 invocation で再取得)。
    // ただし silent degradation を防ぐため Discord 通知 (1h 1 回まで)。
    console.warn('aws-creds KV cache put failed:', err);
    ctx.waitUntil(notifyKvPutFailure(env, err));
  }
}

async function callAssumeRoleWithWebIdentity(
  roleArn: string,
  token: string,
): Promise<CachedCreds> {
  const url = `https://sts.${STS_REGION}.amazonaws.com/`;
  const sessionName = `oidc-${crypto.randomUUID().slice(0, 8)}`;
  const body = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: STS_API_VERSION,
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    WebIdentityToken: token,
    DurationSeconds: String(STS_DURATION_SECONDS),
  }).toString();

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
    });
  } catch (_err) {
    throw new OidcCredentialError('NetworkError', 0);
  }

  const text = await response.text();

  if (!response.ok) {
    // ARN / account ID がエコーされ得る Message / RequestId は捨て、Code のみ抽出。
    const codeMatch = /<Code>([^<]+)<\/Code>/.exec(text);
    const code = codeMatch?.[1] ?? `Http${response.status}`;
    throw new OidcCredentialError(code, response.status);
  }

  return parseAssumeRoleXml(text);
}

function parseAssumeRoleXml(xml: string): CachedCreds {
  const ak = /<AccessKeyId>([^<]+)<\/AccessKeyId>/.exec(xml)?.[1];
  const sk = /<SecretAccessKey>([^<]+)<\/SecretAccessKey>/.exec(xml)?.[1];
  const st = /<SessionToken>([^<]+)<\/SessionToken>/.exec(xml)?.[1];
  const expRaw = /<Expiration>([^<]+)<\/Expiration>/.exec(xml)?.[1];
  if (
    ak === undefined ||
    sk === undefined ||
    st === undefined ||
    expRaw === undefined
  ) {
    throw new OidcCredentialError('ParseError', 0);
  }
  const expMillis = Date.parse(expRaw);
  if (!Number.isFinite(expMillis)) {
    throw new OidcCredentialError('ParseError', 0);
  }
  return {
    accessKeyId: ak,
    secretAccessKey: sk,
    sessionToken: st,
    expiration: Math.floor(expMillis / 1000),
  };
}

function toAwsCredentials(c: CachedCreds): AwsCredentials {
  return {
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken,
  };
}

async function notifyOidcFailure(
  env: Env,
  ctx: ExecutionContext,
  code: string,
  status: number,
): Promise<void> {
  // fire-and-forget で背景化。失敗してもメインの throw を妨げない。
  ctx.waitUntil(
    (async () => {
      try {
        const allowed = await shouldNotify(
          env.SERVER_STATE,
          SUPPRESS_KEY_OIDC_FAIL,
          SUPPRESS_TTL_SECONDS,
        );
        if (!allowed) return;
        await postDiscordWebhookMessage(env, {
          content: `⚠️ Worker OIDC credentials 取得失敗: \`${code}\` (HTTP ${status})`,
        });
      } catch (err) {
        console.warn('notifyOidcFailure threw:', err);
      }
    })(),
  );
}

async function notifyKvPutFailure(env: Env, err: unknown): Promise<void> {
  try {
    const allowed = await shouldNotify(
      env.SERVER_STATE,
      SUPPRESS_KEY_KV_PUT_FAIL,
      SUPPRESS_TTL_SECONDS,
    );
    if (!allowed) return;
    const errName = err instanceof Error ? err.name : 'Unknown';
    await postDiscordWebhookMessage(env, {
      content: `⚠️ Worker OIDC credentials KV cache put 失敗: \`${errName}\` (credentials は配布済、次 invocation で再取得)`,
    });
  } catch (e) {
    console.warn('notifyKvPutFailure threw:', e);
  }
}
