// AWS API 呼び出し失敗時に投げる例外。
//
// AWS の JSON protocol (SSM など) は body に { __type, message } を返す。
// Query protocol (EC2/EBS) は XML で <ErrorResponse><Error><Code>... を返す。
// どちらも raw body を保持しておき、呼び出し側で必要に応じて解釈する。

export class AwsApiError extends Error {
  readonly operation: string;
  readonly statusCode: number;
  readonly body: string;
  readonly awsErrorCode: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    operation: string,
    statusCode: number,
    body: string,
    awsErrorCode?: string,
    requestId?: string,
  ) {
    const prefix = awsErrorCode ? `${awsErrorCode}: ` : '';
    super(`AWS ${operation} failed (HTTP ${statusCode}): ${prefix}${body.slice(0, 500)}`);
    this.name = 'AwsApiError';
    this.operation = operation;
    this.statusCode = statusCode;
    this.body = body;
    this.awsErrorCode = awsErrorCode;
    this.requestId = requestId;
  }

  // status 5xx と一部 4xx (Throttling, RequestLimitExceeded) はリトライ可能。
  get isRetryable(): boolean {
    if (this.statusCode >= 500) return true;
    if (this.statusCode === 429) return true;
    const code = this.awsErrorCode ?? '';
    return (
      code === 'ThrottlingException' ||
      code === 'Throttling' ||
      code === 'RequestLimitExceeded' ||
      code === 'TooManyRequestsException'
    );
  }
}

// JSON protocol レスポンス body から __type と message を抽出。失敗しても throw しない。
export function parseJsonError(body: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as { __type?: string; message?: string; Message?: string };
    const type = parsed.__type;
    const code = type?.includes('#') ? type.split('#').pop() : type;
    return {
      ...(code !== undefined ? { code } : {}),
      ...(parsed.message !== undefined ? { message: parsed.message } : parsed.Message !== undefined ? { message: parsed.Message } : {}),
    };
  } catch {
    return {};
  }
}
