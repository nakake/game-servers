// Cloudflare API 呼び出し失敗時の例外 (admin-webui 側、Phase 7 D-2)。
//
// discord-handler の lib/cloudflare/errors.ts と同じ流儀。admin-webui は ADR 0004 で
// 別 Worker なので、cross-worker import を避け自前のコピーを持つ (小さく依存も無い)。
// Cloudflare API v4 のエラー body: { success:false, errors:[{code,message}], result:null }。

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
    this.name = "CloudflareApiError";
    this.operation = operation;
    this.statusCode = statusCode;
    this.errors = errors;
  }

  // network error は statusCode=0。5xx / 429 / CF rate-limit code は retry 可能。
  get isRetryable(): boolean {
    if (this.statusCode === 0 || this.statusCode >= 500) return true;
    if (this.statusCode === 429) return true;
    return this.errors.some((e) => e.code === 10000 || e.code === 10001);
  }
}
