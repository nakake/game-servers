// Cloudflare API 呼び出し失敗時の例外。
//
// Cloudflare API v4 のエラーレスポンスは:
//   { success: false, errors: [{code, message}, ...], result: null }
//
// HTTP status だけでなく errors 配列にも詳細が入るので両方保持する。

export interface CloudflareApiErrorDetail {
  code: number;
  message: string;
}

export class CloudflareApiError extends Error {
  readonly operation: string;
  readonly statusCode: number;
  readonly errors: CloudflareApiErrorDetail[];

  constructor(
    operation: string,
    statusCode: number,
    summary: string,
    errors: CloudflareApiErrorDetail[] = [],
  ) {
    super(`Cloudflare ${operation} failed (HTTP ${statusCode}): ${summary}`);
    this.name = 'CloudflareApiError';
    this.operation = operation;
    this.statusCode = statusCode;
    this.errors = errors;
  }

  // 5xx と一部の rate limit は retry 可能。
  get isRetryable(): boolean {
    if (this.statusCode >= 500) return true;
    if (this.statusCode === 429) return true;
    // Cloudflare error code 10000 系は rate limit 関連
    return this.errors.some((e) => e.code === 10000 || e.code === 10001);
  }
}
