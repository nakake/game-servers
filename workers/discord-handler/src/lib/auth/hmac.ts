// Sidecar <-> Worker 通信の HMAC-SHA256 認証ヘルパ (Phase 3、docs/phase3-plan.md 決定10)。
//
// 用途:
//   - sidecar (EC2 内 Node コンテナ) が `/sidecar/heartbeat` / `/sidecar/idle-detected`
//     に POST するときと `/sidecar/registry` を GET するときに署名を付ける。
//   - Worker 側で同じ payload を再計算し、Web Crypto の timing-safe な verify で照合する。
//
// payload 正規化 (sidecar / Worker で完全一致させる契約):
//   POST: `${timestamp}\n${body_utf8}`   ← body は sidecar が送った raw 文字列
//   GET : `${METHOD}\n${path_with_query}\n${timestamp}`   例: `GET\n/sidecar/registry?game_id=atm11\n1736000000`
//
// HTTP ヘッダ:
//   X-Sidecar-Timestamp  Unix epoch 秒 (整数文字列)
//   X-Sidecar-Signature  HMAC-SHA256 を standard base64 (RFC 4648 §4) で encode した文字列
//
// timestamp skew: ±300 秒以内のリクエストのみ受理 (replay 防止、design.md §9)。
//
// secret の保管:
//   sidecar: SSM SecureString `/gs/<game_id>/sidecar_hmac_secret`
//   Worker : 環境変数 `SIDECAR_HMAC_SECRETS` (JSON map `{<game_id>: <secret>}`)
//
// Web Crypto の `crypto.subtle.verify` は内部で timing-safe な比較を行うため、
// 自前の string compare による信号漏れは避けられる。

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

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signHmac(payload: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload) as BufferSource,
  );
  return bufferToBase64(sig);
}

export interface VerifyHmacInput {
  payload: string;
  signature: string;
  secret: string;
  // Unix epoch 秒。受信したヘッダから取り出した値をそのまま渡す。
  timestamp: number;
  // 検証時刻 (Unix epoch 秒)。テスト容易性のため呼び出し側で `Math.floor(Date.now()/1000)` を入れる。
  now: number;
  // 既定 300 秒 (design.md §9)。
  maxSkewSec?: number;
}

export async function verifyHmac(input: VerifyHmacInput): Promise<boolean> {
  const maxSkew = input.maxSkewSec ?? 300;
  if (!Number.isFinite(input.timestamp) || !Number.isFinite(input.now)) {
    return false;
  }
  if (Math.abs(input.now - input.timestamp) > maxSkew) {
    return false;
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(input.signature);
  } catch {
    return false;
  }

  let key: CryptoKey;
  try {
    key = await importKey(input.secret);
  } catch {
    return false;
  }

  try {
    return await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes as BufferSource,
      encoder.encode(input.payload) as BufferSource,
    );
  } catch {
    return false;
  }
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    // bytes[i] は noUncheckedIndexedAccess で number | undefined だが、長さ内アクセスなので非 undefined。
    bin += String.fromCharCode(bytes[i] as number);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  // atob は不正な base64 で DOMException (SyntaxError) を投げる → 呼び出し側で catch。
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}
