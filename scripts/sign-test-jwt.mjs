// AWS CLI 手動検証 (Step 2 末尾) 用に、ローカル JWK で 1 個だけ JWT を発行する。
//
// 用途:
//   `aws sts assume-role-with-web-identity --web-identity-token <jwt>` を試行するための token を作る。
//   Step 2.5 の policy tightening 前検証 / 緊急 rotation 後の動作確認に使う。
//
// 詳細: docs/phase5-plan.md Step 2 末尾の「AWS CLI 手動検証」、Step 8 runbook
//
// 使い方:
//   ローカルに既存の private JWK 配列を持っていて、その中の最新鍵で JWT を発行する。
//   stdin から OIDC_PRIVATE_KEYS_JWK の値 (= scripts/generate-oidc-keypair.mjs の出力) を受け取る。
//
//   echo '{"keys":[{...}]}' | node scripts/sign-test-jwt.mjs \
//     --issuer https://discord-handler.<your-account>.workers.dev/oidc \
//     --sub discord-handler-abcd1234 \
//     [--aud sts.amazonaws.com]   # default: sts.amazonaws.com
//     [--ttl 60]                  # default: 60 秒
//
// 出力:
//   stdout に JWT 本体 (1 行)、stderr に header/payload の decoded JSON。
//
// セキュリティ注意:
//   * stdin で受ける = shell 履歴に private key を残さないため
//   * 出力 JWT は短命 (60 秒) なので scrollback に残っても影響は限定的
//   * このスクリプト自体は private key を一切保存しない (メモリ内のみ)

import { subtle, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ---- 引数解釈 ----
const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  if (i === -1) return def;
  const v = args[i + 1];
  if (v === undefined) fail(`${flag} requires a value`);
  return v;
};

const issuer = get('--issuer', undefined);
const sub = get('--sub', undefined);
const aud = get('--aud', 'sts.amazonaws.com');
const ttl = parseInt(get('--ttl', '60'), 10);

if (issuer === undefined) fail('--issuer is required (e.g., https://discord-handler.<your-account>.workers.dev/oidc)');
if (sub === undefined) fail('--sub is required (Workers Secret OIDC_SUB の値と一致させる)');
if (!Number.isFinite(ttl) || ttl < 10 || ttl > 600) fail('--ttl must be 10..600 seconds');

// ---- stdin から JWK 配列を受取 ----
const stdinRaw = readFileSync(0, 'utf8').trim();
if (stdinRaw === '') fail('stdin に OIDC_PRIVATE_KEYS_JWK の JSON を渡してください');

let parsed;
try {
  parsed = JSON.parse(stdinRaw);
} catch (err) {
  fail(`stdin JSON parse 失敗: ${err.message}`);
}
if (!Array.isArray(parsed?.keys) || parsed.keys.length === 0) {
  fail('stdin JSON は {"keys":[...]} 形式で非空配列必須');
}

// 最新 created_at の鍵で署名 (oidc-issuer.ts の挙動と一致)。
const sorted = [...parsed.keys].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
const key = sorted[0];
if (key.kid === undefined || key.kty !== 'RSA') {
  fail('鍵に kid / kty=RSA が必要');
}

const privateKey = await subtle.importKey(
  'jwk',
  key,
  { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  false,
  ['sign'],
);

// ---- JWT 組立 ----
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'RS256', kid: key.kid, typ: 'JWT' };
const payload = {
  iss: issuer.replace(/\/+$/, ''),
  sub,
  aud,
  iat: now,
  nbf: now,
  exp: now + ttl,
  jti: randomUUID(),
};

const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
const sigBytes = await subtle.sign(
  { name: 'RSASSA-PKCS1-v1_5' },
  privateKey,
  new TextEncoder().encode(signingInput),
);
const jwt = `${signingInput}.${b64urlBytes(new Uint8Array(sigBytes))}`;

// ---- 出力 ----
process.stderr.write(`header:  ${JSON.stringify(header)}\n`);
process.stderr.write(`payload: ${JSON.stringify(payload)}\n`);
process.stderr.write(`exp in ${ttl}s (= ${new Date((now + ttl) * 1000).toISOString()})\n`);
process.stderr.write('\n=== JWT (use as --web-identity-token) ===\n');
process.stdout.write(jwt + '\n');
process.stderr.write('\n例:\n');
process.stderr.write('  aws sts assume-role-with-web-identity \\\n');
process.stderr.write(`    --role-arn arn:aws:iam::<account>:role/gs-worker-oidc-role \\\n`);
process.stderr.write('    --role-session-name oidc-test-$(date +%s) \\\n');
process.stderr.write('    --web-identity-token "$(cat above-jwt.txt)"\n');

// ---- helpers ----
function b64url(s) {
  return b64urlBytes(new TextEncoder().encode(s));
}
function b64urlBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fail(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}
