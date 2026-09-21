// AWS API 呼び出しの基盤。
//
// aws4fetch で SigV4 署名し、JSON protocol (SSM/Lambda/etc) の呼び出しを共通化する。
// EC2/EBS の Query protocol (XML) は別レイヤー (ec2.ts) で扱う。
//
// リトライ: exponential backoff + jitter。再試行はこの層にまとめ、aws4fetch の内蔵
//   リトライは retries: 0 で止める。5xx / 429 / Throttling は全 action で maxRetries 回まで
//   (backoff は 200 / 400 / 800 / 1600 / 3000ms + jitter、合計約 6 秒)、
//   abort / ネットワークエラーは再送が安全な action だけ 1 回まで再試行する。
//   失敗時に上位で Discord に通知できるよう AwsApiError で raise する。

import { AwsClient } from 'aws4fetch';

import { AwsApiError, parseJsonError } from './errors.js';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsApiClientOptions {
  region: string;
  credentials: AwsCredentials;
  // リトライ回数 (デフォルト 5)。0 でリトライ無効。
  maxRetries?: number;
}

export interface JsonRequestOptions {
  // SSM の場合は "ssm"。aws4fetch は URL のホストから service を推測するが明示する方が確実。
  service: string;
  // x-amz-target ヘッダ (例: "AmazonSSM.SendCommand")
  target: string;
  // リクエスト body にシリアライズされる JSON。
  payload: Record<string, unknown>;
  // ai タイムアウト (ms)。Workers の subrequest 制限内で。
  timeoutMs?: number;
}

export interface QueryRequestOptions {
  // EC2 / EBS の場合は "ec2"
  service: string;
  // Action name (例: "RunInstances", "DescribeInstances")
  action: string;
  // API version (例: "2016-11-15")
  version: string;
  // URL-encoded body にシリアライズされるパラメータ。
  // AWS Query Protocol の配列展開 (`Foo.1`, `Foo.2`) は呼び出し側で済ませた形で渡す。
  params: Record<string, string>;
  timeoutMs?: number;
}

// ----------------------------------------------------------------------
// 再試行 / タイムアウトの方針
// ----------------------------------------------------------------------

// 1 試行あたりの既定タイムアウト (ms)。
const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;
// 読み取り系は短く切って、経路不調時に再試行する余地を残す。
const READ_ONLY_ATTEMPT_TIMEOUT_MS = 8_000;

// AwsApiError 以外 (abort / ネットワークエラー) の再試行は 1 呼び出しにつき 1 回まで。
const NETWORK_RETRY_LIMIT = 1;

// 読み取り専用 action は prefix で判定する (DescribeInstances / DescribeSnapshots ...)。
const READ_ONLY_OPERATION_PREFIXES = ['Describe'] as const;
// prefix で拾えない読み取り専用 action。
const READ_ONLY_OPERATIONS = new Set(['GetCommandInvocation']);

// 読み取り系以外で abort / ネットワークエラーを再試行してよい action。
//   5xx / 429 は action を問わず再試行される (従来からの挙動)。ここで制御するのは
//   「届いたか不明」な abort / ネットワークエラーの再送可否だけ。
//   TerminateInstances: 冪等なので再送してよい。
//   RunInstances: 再送で二重起動し得るので、ClientToken があるときだけ許可する
//     (ec2.ts を経由しない呼び出しでも、token なしでは再送されない)。
//   CreateSnapshot / DeleteVolume / DeleteSnapshot / SendCommand は入れない
//   (再送すると重複や NotFound になり得る)。
const NETWORK_RETRY_OPERATIONS = new Set(['TerminateInstances']);
// ClientToken による重複排除が効く action。params に token が無ければ再送しない。
const CLIENT_TOKEN_OPERATIONS = new Set(['RunInstances']);

function isReadOnlyOperation(operation: string): boolean {
  return (
    READ_ONLY_OPERATION_PREFIXES.some((prefix) => operation.startsWith(prefix)) ||
    READ_ONLY_OPERATIONS.has(operation)
  );
}

// params / payload に空でない ClientToken が含まれているか。
function containsClientToken(params: Record<string, unknown>): boolean {
  const token = params['ClientToken'];
  return typeof token === 'string' && token !== '';
}

// abort / ネットワークエラーを再試行してよい action か。
// RunInstances は ClientToken が含まれているときだけ許可する (二重起動防止)。
function allowsNetworkRetry(operation: string, hasClientToken: boolean): boolean {
  if (isReadOnlyOperation(operation)) return true;
  if (CLIENT_TOKEN_OPERATIONS.has(operation)) return hasClientToken;
  return NETWORK_RETRY_OPERATIONS.has(operation);
}

// 1 試行のタイムアウト。読み取り系だけ 8 秒に抑える (呼び出し側の指定が短ければそちらを優先)。
function attemptTimeoutMs(operation: string, timeoutMs: number | undefined): number {
  const base = timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  return isReadOnlyOperation(operation) ? Math.min(base, READ_ONLY_ATTEMPT_TIMEOUT_MS) : base;
}

export class AwsApiClient {
  private readonly aws: AwsClient;
  private readonly maxRetries: number;
  readonly region: string;

  constructor(options: AwsApiClientOptions) {
    this.region = options.region;
    this.maxRetries = options.maxRetries ?? 5;
    this.aws = new AwsClient({
      accessKeyId: options.credentials.accessKeyId,
      secretAccessKey: options.credentials.secretAccessKey,
      ...(options.credentials.sessionToken !== undefined
        ? { sessionToken: options.credentials.sessionToken }
        : {}),
      region: options.region,
      // 内蔵リトライを止め、再試行は withRetry に一本化する (二重リトライ防止)。
      retries: 0,
    });
  }

  // AWS JSON protocol (SSM/Lambda 等) を叩く。レスポンスを JSON として返す。
  async jsonRequest<T>(opts: JsonRequestOptions): Promise<T> {
    const url = `https://${opts.service}.${this.region}.amazonaws.com/`;
    const body = JSON.stringify(opts.payload);
    const operation = opts.target.split('.').pop() ?? opts.target;
    const timeoutMs = attemptTimeoutMs(operation, opts.timeoutMs);

    return this.withRetry(operation, containsClientToken(opts.payload), async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.aws.fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-amz-json-1.1',
            'x-amz-target': opts.target,
          },
          body,
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          const parsed = parseJsonError(text);
          throw new AwsApiError(
            operation,
            response.status,
            text,
            parsed.code,
            response.headers.get('x-amzn-requestid') ?? undefined,
          );
        }
        return JSON.parse(text) as T;
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  // AWS Query protocol (EC2 / EBS) を叩く。レスポンスは XML 文字列のまま返す。
  // XML パースは呼び出し側 (ec2.ts) の専用 parser に任せる。
  async queryRequest(opts: QueryRequestOptions): Promise<string> {
    const url = `https://${opts.service}.${this.region}.amazonaws.com/`;
    const body = new URLSearchParams({
      Action: opts.action,
      Version: opts.version,
      ...opts.params,
    }).toString();
    const timeoutMs = attemptTimeoutMs(opts.action, opts.timeoutMs);

    return this.withRetry(opts.action, containsClientToken(opts.params), async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.aws.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
          body,
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          // AWS Query protocol のエラーは XML: <ErrorResponse><Error><Code>...
          const codeMatch = /<Code>([^<]+)<\/Code>/.exec(text);
          const reqIdMatch = /<RequestID>([^<]+)<\/RequestID>/.exec(text);
          throw new AwsApiError(
            opts.action,
            response.status,
            text,
            codeMatch?.[1],
            reqIdMatch?.[1] ?? response.headers.get('x-amzn-requestid') ?? undefined,
          );
        }
        return text;
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  // リトライ可能なエラーは exponential backoff。それ以外は即 throw。
  // AwsApiError 以外 (abort / ネットワークエラー) は許可リストの action だけ 1 回再試行する。
  // 総試行回数はどちらの経路でも maxRetries + 1 を超えない。
  private async withRetry<T>(
    operation: string,
    hasClientToken: boolean,
    fn: () => Promise<T>,
  ): Promise<T> {
    const networkRetryAllowed = allowsNetworkRetry(operation, hasClientToken);
    let networkRetries = 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (err instanceof AwsApiError) {
          if (!err.isRetryable || attempt === this.maxRetries) break;
        } else {
          if (
            !networkRetryAllowed ||
            networkRetries >= NETWORK_RETRY_LIMIT ||
            attempt === this.maxRetries
          ) {
            break;
          }
          networkRetries++;
        }
        // 200 / 400 / 800 / 1600 / 3000ms + jitter。aws4fetch の内蔵リトライを止めた分、
        // 5xx に粘れる時間を合計約 6 秒確保する (Terminate 失敗 = 次 Cron まで課金のため)。
        const backoffMs = Math.min(2 ** attempt * 200, 3000) + Math.random() * 100;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new AwsApiError(operation, 0, String(lastError));
  }
}
