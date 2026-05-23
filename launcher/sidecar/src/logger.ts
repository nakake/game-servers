// 最小ロガー。Phase 3 では構造化ログまでは不要 (CloudWatch でテキスト grep で十分)。
// 必要なら pino 等を後で導入する。

export const log = {
  info(message: string, ctx?: Record<string, unknown>): void {
    console.log(formatLine('INFO', message, ctx));
  },
  warn(message: string, ctx?: Record<string, unknown>): void {
    console.warn(formatLine('WARN', message, ctx));
  },
  error(message: string, ctx?: Record<string, unknown>): void {
    console.error(formatLine('ERROR', message, ctx));
  },
};

function formatLine(level: string, message: string, ctx?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  if (ctx === undefined || Object.keys(ctx).length === 0) {
    return `${ts} [${level}] sidecar: ${message}`;
  }
  return `${ts} [${level}] sidecar: ${message} ${JSON.stringify(ctx)}`;
}
