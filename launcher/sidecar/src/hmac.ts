// Worker (workers/discord-handler/src/lib/auth/hmac.ts) と相互互換の HMAC-SHA256 署名。
//
// 仕様は docs/phase3-plan.md 決定10:
//   POST: `${timestamp}\n${body}` (LF 1 文字)
//   GET : `${METHOD}\n${path_with_query}\n${timestamp}`
//   HMAC-SHA256 を standard base64 で encode して X-Sidecar-Signature ヘッダに乗せる。
//
// Node 22 LTS の Web Crypto API (`node:crypto` の `webcrypto`) を使うことで、Worker 側
// (`globalThis.crypto.subtle`) と同一の挙動を担保する。テスト (src/hmac.test.ts) で Worker
// 側の単体テストと同じ入力に同じ署名を生成することを確認する。

import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();

export function formatPostPayload(timestamp: number, body: string): string {
  return `${timestamp}\n${body}`;
}

export function formatGetPayload(
  method: string,
  pathWithQuery: string,
  timestamp: number,
): string {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}`;
}

export async function signHmac(payload: string, secret: string): Promise<string> {
  const key = await subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', key, encoder.encode(payload));
  return Buffer.from(sig).toString('base64');
}

export function currentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
