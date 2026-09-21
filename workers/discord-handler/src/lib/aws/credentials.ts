// AWS credential provider (Phase 5)。
//
// Worker は AssumeRoleWithWebIdentity で 15min 短期 credentials を取得し、
// 全 AWS API 呼び出し直前に getAwsCredentials(env, ctx) でこれを取る。
// 旧 IAM Access Key 経路は Step 7 (2026-05-24) で完全削除済。
//
// 動作 (docs/phase5-plan.md Step 3):
//   1. in-flight Promise dedup (ctx 単位。同 invocation の並列呼び出しを 1 本化)
//   2. KV `SERVER_STATE` `aws-creds:cache` 読み、残り時間 remaining = expiration - now で 3 分岐:
//        - remaining > 420s: cache をそのまま return (STS も JWT も呼ばない)
//        - 61〜420s (更新窓): STS を 1 回だけ timeout 3 秒で試す。成功なら新 credentials を
//          cache に書いて return、失敗なら console.warn (code のみ) して cache を return。
//          throw も Discord 通知もしない
//        - remaining <= 60s / cache なし: STS を最大 3 回試行 (timeout 3 / 5 / 8 秒)
//   3. issueStsWebIdentityToken で JWT 発行 (sub/aud/ttl=60s が module-private で固定)。
//      1 回の getAwsCredentials につき 1 回だけ発行し、再試行では同じ token を使い回す
//   4. STS regional endpoint (ap-northeast-1) に AssumeRoleWithWebIdentity POST (DurationSeconds=900)
//   5. XML から AccessKeyId / SecretAccessKey / SessionToken / Expiration を抽出
//   6. KV put TTL = (expiration - now - 60) - random(0..30)  ★負方向 jitter のみ
//      ctx.waitUntil で fire-and-forget、credentials は即 return
//
// 再試行 (期限切れ経路): fetch の失敗 (abort は Timeout、それ以外は NetworkError)、
//   HTTP 5xx (Cloudflare 合成の 520 / 525 を含む)、429、IDPCommunicationError (HTTP 400)、
//   ParseError (200 だが本文が途中で切れた場合)。backoff は 200ms × 2^n + jitter (0..100ms)。
//   それ以外の 4xx は設定誤りなので、再送しても結果が変わらず即失敗させる。
//
// Sentinel + 安全設計:
//   - oidc mode で STS / JWT / parse 失敗 → **絶対に static fallback しない**。OidcCredentialError を throw
//   - 更新窓で返すのは、まだ有効な OIDC 発行 credentials (KV cache の値) であり、
//     静的な IAM Access Key への fallback ではない。static fallback 禁止の不変条件は維持している
//   - STS error の Code は出力 (Discord 通知に流す)、Message は ARN/account ID を含む可能性があるため捨てる
//   - JWT は log / 通知に絶対出力しない (signOidcToken の戻り値を toString 経由でも漏らさない)
//   - 全 OidcCredentialError は Phase 4 webhook に 1h 1 回まで通知 (notif-suppress)。
//     ただし更新窓の失敗は通知しない (cache がまだ有効で、経路不調のたびに鳴らす必要がない)
//   - KV put 失敗 → credentials は return。期限切れ経路の失敗だけ Discord に 1h 1 回通知する
//     (更新窓は cache がまだ有効で、同時更新の KV 書き込み競合でも鳴り得るため warn のみ)
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

  // 一過性の失敗か (= 再試行で回復し得るか)。Timeout / NetworkError、5xx、429 に加え、
  // IDPCommunicationError (STS が IdP に到達できないときの HTTP 400。AWS も再試行を推奨) と
  // ParseError (200 だが本文が途中で切れた場合) が該当する。
  // それ以外の 4xx (設定誤り) は再送しても結果が変わらないため false。
  get isTransient(): boolean {
    if (this.code === 'Timeout' || this.code === 'NetworkError') return true;
    if (this.code === 'IDPCommunicationError' || this.code === 'ParseError') return true;
    return this.status >= 500 || this.status === 429;
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
// 残り時間がこれを超えていれば cache をそのまま使う。420s 以下で早期更新 (更新窓) に入る。
const REFRESH_AHEAD_SECONDS = 420;
// 期限切れ経路 (残り 60s 以下 / cache なし) の 1 試行ごとのタイムアウト。
const STS_ATTEMPT_TIMEOUTS_MS = [3_000, 5_000, 8_000] as const;
// 更新窓 (残り 61〜420s) の STS は 1 回だけなので、期限切れ経路の初回と同じ 3 秒で切る。
const REFRESH_WINDOW_TIMEOUT_MS = STS_ATTEMPT_TIMEOUTS_MS[0];
// 再試行前の backoff: 200ms × 2^n + jitter (0..100ms)。
const BACKOFF_BASE_MS = 200;
const BACKOFF_JITTER_MS = 100;
const CACHE_NEGATIVE_JITTER_SECONDS = 30;
const KV_TTL_MINIMUM_SECONDS = 60;
const SUPPRESS_TTL_SECONDS = 3600;
const SUPPRESS_KEY_OIDC_FAIL = 'oidc-credential-fail';
const SUPPRESS_KEY_KV_PUT_FAIL = 'oidc-cache-kv-put-fail';

// module-scope in-flight Promise dedup。キーは呼び出し元から渡された ExecutionContext。
// 同 invocation (= 同 ctx) の並列呼び出しを 1 本に絞る。待ち時間が最大 16.8 秒に伸びたため、
// module 全体の Map だと無関係なリクエストが同じ Promise を待ってしまい、workerd が
// リクエストをまたぐ継続を保証しない。ctx 単位なら Cron の 3 ハンドラ (同じ ctx) は dedup できる。
let inflight = new WeakMap<ExecutionContext, Promise<AwsCredentials>>();

// テスト用 reset。production code からは呼ばない。
export function _resetInflight(): void {
  inflight = new WeakMap();
}

// AWS API 呼び出しの直前に呼ぶ。credentials は AwsApiClient コンストラクタに渡す。
export async function getAwsCredentials(
  env: Env,
  ctx: ExecutionContext,
): Promise<AwsCredentials> {
  // Phase 5 Step 7 (2026-05-24) で OIDC 専用化済。静的 IAM Access Key 経路は完全削除、
  // AWS_AUTH_MODE 分岐も廃止 (env.ts から型ごと削除)。
  const existing = inflight.get(ctx);
  if (existing !== undefined) return existing;

  // IIFE で promise を作り、finally でその ctx の dedup エントリの cleanup を保証する。
  // 元 promise を inflight.set + return することで dedup の 2 回目以降も同じ promise を共有。
  const promise = (async () => {
    try {
      return await fetchOidcCredentials(env, ctx);
    } finally {
      inflight.delete(ctx);
    }
  })();
  inflight.set(ctx, promise);
  return promise;
}

// 更新窓の warn 用。OidcCredentialError 以外は 'Unknown' に丸める
// (予期しない例外のメッセージを log に流さない)。
function errorCodeOf(err: unknown): string {
  return err instanceof OidcCredentialError ? err.code : 'Unknown';
}

async function fetchOidcCredentials(
  env: Env,
  ctx: ExecutionContext,
): Promise<AwsCredentials> {
  // 1. KV cache。残り時間で「そのまま返す / 更新窓 / 期限切れ」に分ける。
  const cache = await readCache(env);
  if (cache.kind === 'fresh') return toAwsCredentials(cache.creds);

  // 2. JWT は 1 回だけ発行し、再試行では同じ token を使い回す
  //    (ttl 60s。最悪でも timeout 3+5+8 秒 + backoff 0.8 秒 = 16.8 秒で完了する)。
  let token: string;
  try {
    token = await issueStsWebIdentityToken(env);
  } catch (err) {
    // JWT 発行失敗 = OIDC_SUB 未設定 / private key 不正 / WORKER_PUBLIC_URL 未設定 等の config 不備。
    // 詳細メッセージは wrangler tail で根本原因を切り分けるため console.error に残す
    // (JWT 本体は ttl=60s の短命で token 自体は未生成なので機密漏洩リスク無し)。
    // Discord 通知には code のみ (ARN/account ID 漏洩防止)。
    console.error(
      'issueStsWebIdentityToken failed:',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    if (cache.kind === 'refresh-window') {
      // 更新窓では cache がまだ有効なので、通知も throw もせずに cache を返す。
      console.warn('aws-creds refresh failed, serving cached credentials:', 'JwtIssueFailed');
      return toAwsCredentials(cache.creds);
    }
    await notifyOidcFailure(env, ctx, 'JwtIssueFailed', 0);
    throw new OidcCredentialError('JwtIssueFailed', 0);
  }

  if (cache.kind === 'refresh-window') {
    // 3. 更新窓: STS は 1 回だけ。失敗しても、まだ有効な OIDC 発行 credentials を返す
    //    (static IAM Access Key への fallback ではない。上のヘッダ参照)。
    try {
      const creds = await callAssumeRoleWithWebIdentity(
        env.AWS_OIDC_ROLE_ARN,
        token,
        REFRESH_WINDOW_TIMEOUT_MS,
      );
      // 更新窓の put 失敗は cache にまだ有効な credentials が残るため通知しない (writeCache 内で warn のみ)。
      ctx.waitUntil(writeCache(env, ctx, creds, { notifyOnFailure: false }));
      return toAwsCredentials(creds);
    } catch (err) {
      // エラーコードのみを warn する (Message は ARN/account ID を含み得るため出さない)。
      console.warn('aws-creds refresh failed, serving cached credentials:', errorCodeOf(err));
      return toAwsCredentials(cache.creds);
    }
  }

  // 4. 期限切れ / cache なし: 最大 3 回試行し、全滅したら通知 + throw。
  let creds: CachedCreds;
  try {
    creds = await callAssumeRoleWithRetry(env.AWS_OIDC_ROLE_ARN, token);
  } catch (err) {
    if (err instanceof OidcCredentialError) {
      await notifyOidcFailure(env, ctx, err.code, err.status);
      throw err;
    }
    await notifyOidcFailure(env, ctx, 'Unknown', 0);
    throw new OidcCredentialError('Unknown', 0);
  }

  // 5. KV put は fire-and-forget。credentials は呼び出し側に即 return。
  // ctx.waitUntil で背景化することで cache write の失敗が caller を block しない。
  ctx.waitUntil(writeCache(env, ctx, creds, { notifyOnFailure: true }));

  return toAwsCredentials(creds);
}

// cache の状態。remaining = expiration - now (秒) で分ける。
//   fresh:          残り 421s 以上。そのまま返してよい
//   refresh-window: 残り 61〜420s。まだ有効だが、失効前に早めに更新する
//   expired:        残り 60s 以下 / cache なし / 壊れた値。取り直す
type CacheState =
  | { kind: 'fresh'; creds: CachedCreds }
  | { kind: 'refresh-window'; creds: CachedCreds }
  | { kind: 'expired' };

async function readCache(env: Env): Promise<CacheState> {
  const raw = await env.SERVER_STATE.get(CACHE_KEY);
  if (raw === null) return { kind: 'expired' };
  let parsed: CachedCreds;
  try {
    parsed = JSON.parse(raw) as CachedCreds;
  } catch {
    // 壊れた cache は無視して再取得する。意図的に warn は出さない (eventual consistency 中の
    // 半端な値を踏むケースが起こり得るが、再取得で復旧する)。
    return { kind: 'expired' };
  }
  const now = Math.floor(Date.now() / 1000);
  const remaining = parsed.expiration - now;
  // expiration の欠落 / NaN で残り時間が計算できない cache は壊れている。更新窓に分類すると
  // STS 失敗時に壊れた credentials を返してしまうため、expired 扱いにして取り直す。
  if (!Number.isFinite(remaining)) return { kind: 'expired' };
  // 残 60s 以下なら expired 扱い (race を避けるため早めに refresh)。既存の境界は変えない。
  if (remaining <= CACHE_EARLY_REFRESH_SECONDS) return { kind: 'expired' };
  // 残 421s 以上あれば次の失効まで余裕があるので、STS を呼ばずに cache を返す。
  if (remaining > REFRESH_AHEAD_SECONDS) return { kind: 'fresh', creds: parsed };
  return { kind: 'refresh-window', creds: parsed };
}

async function writeCache(
  env: Env,
  ctx: ExecutionContext,
  creds: CachedCreds,
  options: { notifyOnFailure: boolean },
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
    // ただし silent degradation を防ぐため、期限切れ経路では Discord 通知 (1h 1 回まで)。
    // 更新窓では cache にまだ有効な credentials が残っており実害が無いこと、別 invocation が
    // 同時に更新して同じキーへ書くと KV の「1 キー 1 秒 1 書き込み」制限に当たり誤報になること
    // から、warn だけにして通知しない。
    console.warn('aws-creds KV cache put failed:', err);
    if (options.notifyOnFailure) ctx.waitUntil(notifyKvPutFailure(env, err));
  }
}

// 期限切れ経路の STS 呼び出し。最大 3 回試行し、一過性の失敗 (isTransient) だけ backoff して再送する。
// JWT (token) は呼び出し側で 1 回発行したものを使い回す。
async function callAssumeRoleWithRetry(roleArn: string, token: string): Promise<CachedCreds> {
  let lastError = new OidcCredentialError('Unknown', 0);
  for (const [attempt, timeoutMs] of STS_ATTEMPT_TIMEOUTS_MS.entries()) {
    try {
      return await callAssumeRoleWithWebIdentity(roleArn, token, timeoutMs);
    } catch (err) {
      if (!(err instanceof OidcCredentialError)) throw err;
      lastError = err;
      // 再試行するのは isTransient な失敗 (fetch の失敗 / 5xx / 429 / IDPCommunicationError /
      // ParseError)。それ以外の 4xx (設定誤り等) は再送しても変わらないため即失敗させる。
      if (!err.isTransient || attempt === STS_ATTEMPT_TIMEOUTS_MS.length - 1) break;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError;
}

// 再試行前の待ち。200ms × 2^n + jitter (0..100ms)。
function backoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** attempt + Math.random() * BACKOFF_JITTER_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callAssumeRoleWithWebIdentity(
  roleArn: string,
  token: string,
  timeoutMs: number,
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

  // 1 試行ごとに AbortController でタイムアウトを掛ける。response.text() の読み取りも
  // 同じタイマーの対象に含め、タイマーは finally で必ず clear する。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body,
        signal: controller.signal,
      });
      text = await response.text();
    } catch {
      // abort による失敗は Timeout、それ以外の fetch 例外は NetworkError。
      throw new OidcCredentialError(controller.signal.aborted ? 'Timeout' : 'NetworkError', 0);
    }

    if (!response.ok) {
      // ARN / account ID がエコーされ得る Message / RequestId は捨て、Code のみ抽出。
      const codeMatch = /<Code>([^<]+)<\/Code>/.exec(text);
      const code = codeMatch?.[1] ?? `Http${response.status}`;
      throw new OidcCredentialError(code, response.status);
    }

    return parseAssumeRoleXml(text);
  } finally {
    clearTimeout(timer);
  }
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
