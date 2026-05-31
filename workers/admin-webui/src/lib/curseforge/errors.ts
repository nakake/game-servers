// CurseForge API 呼び出し失敗時の例外。
//
// CloudflareApiError と同じ流儀 (operation / statusCode / isRetryable) に揃える。
// CF は標準的な HTTP status を返し、エラー body 形式は安定しないので status を主に扱う。
// network error (fetch 自体の throw) は statusCode=0 で表現する。

export class CurseForgeApiError extends Error {
  readonly operation: string;
  readonly statusCode: number;

  constructor(operation: string, statusCode: number, summary: string) {
    super(`CurseForge ${operation} failed (HTTP ${statusCode}): ${summary}`);
    this.name = "CurseForgeApiError";
    this.operation = operation;
    this.statusCode = statusCode;
  }

  // 5xx / 429 / network error は retry 可能。rate limit は未公開だが 429 を一応含める。
  get isRetryable(): boolean {
    return (
      this.statusCode === 0 || this.statusCode === 429 || this.statusCode >= 500
    );
  }
}
