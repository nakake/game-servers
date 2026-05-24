// OIDC private key 生成 / rotation スクリプト (Phase 5)。
//
// workers/discord-handler/src/lib/auth/oidc-issuer.ts が読む `OIDC_PRIVATE_KEYS_JWK` (Workers Secret) を
// 生成・回転する。RS256 (RSASSA-PKCS1-v1_5 + SHA-256, RSA-2048) で、rotation 中の新旧並走 (multi-kid) を
// サポートするため値は JWK 配列形式 `{"keys":[...]}` で保持する。
//
// 詳細仕様: docs/phase5-plan.md Step 1 / Step 8 (rotation runbook)。
//
// 使い方:
//   node scripts/generate-oidc-keypair.mjs --fresh
//     新規生成 (配列リセット、鍵 1 個のみ)。初回 / 漏洩時の緊急 rotation で使う。
//
//   node scripts/generate-oidc-keypair.mjs --rotate
//     既存配列の末尾に新鍵を追加。標準入力から既存 OIDC_PRIVATE_KEYS_JWK の JSON を受け取る:
//       wrangler secret list | grep OIDC_PRIVATE_KEYS_JWK   (= 存在確認のみ、値は取れない)
//       cat existing.json | node scripts/generate-oidc-keypair.mjs --rotate
//     stdin が無ければ --fresh と同じ動作。
//
//   node scripts/generate-oidc-keypair.mjs --remove-old
//     既存配列から最新以外の鍵 (= 旧 kid) を削除して残り 1 個にする。rotation 後の cleanup。
//     stdin から既存配列を受け取る (--rotate と同じ流儀)。
//
// 出力:
//   stdout に生成された OIDC_PRIVATE_KEYS_JWK の値 (1 行 JSON) と投入手順を出す。
//   投入: 出力の JSON 部分だけをコピーして `wrangler secret put OIDC_PRIVATE_KEYS_JWK` に貼る。

import { subtle, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ---- 引数解釈 ----
const args = process.argv.slice(2);
const mode = args.find((a) => ['--fresh', '--rotate', '--remove-old'].includes(a)) ?? '--fresh';

// ---- 既存配列の読み込み (rotate / remove-old) ----
function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let existingKeys = [];
if (mode === '--rotate' || mode === '--remove-old') {
  const stdin = readStdinSync().trim();
  if (stdin === '') {
    if (mode === '--remove-old') {
      fail('--remove-old は stdin に既存 OIDC_PRIVATE_KEYS_JWK の JSON が必要');
    }
    log('stdin が空のため --fresh と同じ挙動で生成します');
  } else {
    try {
      const parsed = JSON.parse(stdin);
      if (!Array.isArray(parsed?.keys)) {
        fail('stdin の JSON に keys 配列がありません');
      }
      existingKeys = parsed.keys;
    } catch (err) {
      fail(`stdin の JSON parse 失敗: ${err.message}`);
    }
  }
}

// ---- メイン ----
if (mode === '--remove-old') {
  if (existingKeys.length === 0) {
    fail('既存配列が空、削除対象なし');
  }
  // created_at 最大の鍵 1 個だけ残す。
  existingKeys.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const kept = existingKeys[0];
  log(`旧 kid を削除して残り 1 個に: 残す kid=${kept.kid} created_at=${kept.created_at}`);
  emit({ keys: [kept] });
} else {
  // --fresh / --rotate: 新鍵を 1 個生成
  const { publicKey, privateKey } = await subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), // 65537
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );

  // private JWK を export し、kid / created_at / alg / use を付与。
  const privJwk = await subtle.exportKey('jwk', privateKey);
  const kid = randomUUID();
  const created_at = Math.floor(Date.now() / 1000);
  const newKey = {
    kid,
    use: 'sig',
    alg: 'RS256',
    created_at,
    ...privJwk,
  };

  // public JWK の export はテストでのみ使う (issuer は private から runtime で導出するため不要)。
  // 検証用に stdout に別途出すと secret 値と混ざるので、必要なら別オプションで。
  void publicKey;

  let newKeys;
  if (mode === '--rotate' && existingKeys.length > 0) {
    newKeys = [...existingKeys, newKey];
    log(`既存 ${existingKeys.length} 個に新 kid=${kid} を追加 (合計 ${newKeys.length} 個)`);
  } else {
    newKeys = [newKey];
    log(`新鍵 kid=${kid} を 1 個生成 (--fresh モード)`);
  }
  emit({ keys: newKeys });
}

// ---- helpers ----
function emit(obj) {
  const value = JSON.stringify(obj);
  log('');
  log('=== 投入手順 ===');
  log('1. 下の JSON 1 行を**そのまま**コピー (改行混入禁止):');
  log('');
  process.stdout.write(value + '\n');
  log('');
  log('2. workers/discord-handler ディレクトリで以下を実行:');
  log('   pnpm wrangler secret put OIDC_PRIVATE_KEYS_JWK');
  log('   プロンプトに上の JSON をペースト + Enter');
  log('');
  log('Staging に投入するなら --env staging を付ける:');
  log('   pnpm wrangler secret put OIDC_PRIVATE_KEYS_JWK --env staging');
}

function log(msg) {
  // stderr に出して stdout (= 投入対象の JSON) と混ざらないようにする。
  process.stderr.write(msg + '\n');
}

function fail(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}
