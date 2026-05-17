// AWS API 呼び出しの基盤。
//
// aws4fetch で SigV4 署名し、JSON protocol (SSM/Lambda/etc) の呼び出しを共通化する。
// EC2/EBS の Query protocol (XML) は別レイヤー (ec2.ts) で扱う。
//
// リトライ: exponential backoff + jitter。Workers の CPU 時間制約を考えて max 3 回。
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
  // リトライ回数 (デフォルト 3)。0 でリトライ無効。
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

export class AwsApiClient {
  private readonly aws: AwsClient;
  private readonly maxRetries: number;
  readonly region: string;

  constructor(options: AwsApiClientOptions) {
    this.region = options.region;
    this.maxRetries = options.maxRetries ?? 3;
    this.aws = new AwsClient({
      accessKeyId: options.credentials.accessKeyId,
      secretAccessKey: options.credentials.secretAccessKey,
      ...(options.credentials.sessionToken !== undefined
        ? { sessionToken: options.credentials.sessionToken }
        : {}),
      region: options.region,
    });
  }

  // AWS JSON protocol (SSM/Lambda 等) を叩く。レスポンスを JSON として返す。
  async jsonRequest<T>(opts: JsonRequestOptions): Promise<T> {
    const url = `https://${opts.service}.${this.region}.amazonaws.com/`;
    const body = JSON.stringify(opts.payload);
    const operation = opts.target.split('.').pop() ?? opts.target;

    return this.withRetry(operation, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
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

    return this.withRetry(opts.action, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
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
  private async withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const retryable = err instanceof AwsApiError && err.isRetryable;
        if (!retryable || attempt === this.maxRetries) break;
        const backoffMs = Math.min(2 ** attempt * 100, 2000) + Math.random() * 100;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new AwsApiError(operation, 0, String(lastError));
  }
}
