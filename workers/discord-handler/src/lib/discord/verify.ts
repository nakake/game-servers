// Discord interaction の ed25519 署名検証。
//
// Discord は POST /discord/interaction に以下のヘッダを付けて送信する:
//   X-Signature-Ed25519:   署名 (hex)
//   X-Signature-Timestamp: timestamp (秒)
//
// 検証式: ed25519.verify(public_key, timestamp + body, signature)
//
// Workers の Web Crypto API は Ed25519 を標準サポート (compatibility_date 2024-09-01 以降)。
// 当 Worker は 2026-05-01 を採用しているので問題なし。
//
// 参照: https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization

export interface VerifyResult {
  valid: boolean;
  // 検証成功時のリクエスト body (signature 計算のために 1 回消費するため、ハンドラには
  // ここから渡す)。検証失敗時は空文字。
  body: string;
}

export async function verifyDiscordRequest(
  request: Request,
  publicKeyHex: string,
): Promise<VerifyResult> {
  const signatureHex = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (signatureHex === null || timestamp === null) {
    return { valid: false, body: '' };
  }

  const body = await request.text();
  const message = new TextEncoder().encode(timestamp + body);

  let signature: Uint8Array;
  let publicKey: Uint8Array;
  try {
    signature = hexToBytes(signatureHex);
    publicKey = hexToBytes(publicKeyHex);
  } catch {
    return { valid: false, body: '' };
  }

  if (publicKey.length !== 32 || signature.length !== 64) {
    return { valid: false, body: '' };
  }

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      'Ed25519',
      key,
      signature as BufferSource,
      message as BufferSource,
    );
  } catch {
    return { valid: false, body: '' };
  }

  return { valid, body: valid ? body : '' };
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must have even length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid hex character');
    bytes[i / 2] = byte;
  }
  return bytes;
}
