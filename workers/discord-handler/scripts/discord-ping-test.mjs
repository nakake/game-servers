// Phase 1 検証用: テスト用 ed25519 鍵ペアで PING を Worker に投げて type:1 (PONG) を確認。
//
// 使い方:
//   node scripts/discord-ping-test.mjs --write-env
//     → 鍵ペア生成 → .dev.vars の DISCORD_PUBLIC_KEY を更新 → 秘密鍵を .discord-test-keypair.json に保存
//   node scripts/discord-ping-test.mjs
//     → 保存済み秘密鍵で PING を署名して投げ、レスポンス確認
//
// `.discord-test-keypair.json` は秘密鍵を含む throwaway ファイル。.gitignore で除外。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devVarsPath = path.resolve(__dirname, '..', '.dev.vars');
const keypairPath = path.resolve(__dirname, '..', '.discord-test-keypair.json');
const writeEnv = process.argv.includes('--write-env');

if (writeEnv) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyHex = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('hex');

  let envContent = fs.existsSync(devVarsPath) ? fs.readFileSync(devVarsPath, 'utf8') : '';
  if (/^DISCORD_PUBLIC_KEY=.*/m.test(envContent)) {
    envContent = envContent.replace(/^DISCORD_PUBLIC_KEY=.*/m, `DISCORD_PUBLIC_KEY=${publicKeyHex}`);
  } else {
    if (envContent.length > 0 && !envContent.endsWith('\n')) envContent += '\n';
    envContent += `DISCORD_PUBLIC_KEY=${publicKeyHex}\n`;
  }
  fs.writeFileSync(devVarsPath, envContent);

  fs.writeFileSync(
    keypairPath,
    JSON.stringify({
      publicKeyHex,
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    }),
  );

  console.log(`Wrote DISCORD_PUBLIC_KEY=${publicKeyHex.slice(0, 16)}... to ${devVarsPath}`);
  console.log(`Saved keypair to ${keypairPath}`);
  console.log();
  console.log('Wrangler dev should hot-reload .dev.vars within a few seconds.');
  console.log('Then re-run: node scripts/discord-ping-test.mjs');
  process.exit(0);
}

// ---- test mode ----
if (!fs.existsSync(keypairPath)) {
  console.error(`No keypair found at ${keypairPath}`);
  console.error('Run with --write-env first.');
  process.exit(1);
}
const kp = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
const privateKey = crypto.createPrivateKey(kp.privateKeyPem);

const timestamp = Math.floor(Date.now() / 1000).toString();
const body = JSON.stringify({ type: 1 });
const signature = crypto.sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');

const url = process.env.WORKER_URL ?? 'http://localhost:8787/discord/interaction';
console.log(`POST ${url}`);
console.log(`  publicKey: ${kp.publicKeyHex.slice(0, 16)}...`);
console.log(`  signature: ${signature.slice(0, 16)}...`);

const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-signature-ed25519': signature,
    'x-signature-timestamp': timestamp,
  },
  body,
});
const text = await response.text();
console.log(`\nStatus: ${response.status}`);
console.log(`Body:   ${text}`);

if (response.status === 200 && text.includes('"type":1')) {
  console.log('\nPASS: Worker returned PONG (type:1)');
  process.exit(0);
} else if (response.status === 401) {
  console.error('\nFAIL (401): DISCORD_PUBLIC_KEY in Worker env does not match saved keypair.');
  console.error('  → Restart wrangler dev (pnpm dev) to reload .dev.vars, then rerun.');
  process.exit(1);
} else {
  console.error('\nFAIL: unexpected response');
  process.exit(1);
}
