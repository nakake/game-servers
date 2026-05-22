// ゲーム登録スクリプト (Phase 2)。
//
// games/<game_id>/registry.json を外部リソースに反映する:
//   ① Cloudflare DNS  : <subdomain>.<base_domain> の A レコードを作成 (placeholder IP)。
//                       既存ならスキップ。取得した record_id を registry.json に書き戻す。
//   ② S3 config sync  : games/<game_id>/config/ を registry の config_s3_prefix に sync。
//   ③ Workers KV 投入 : registry.json を GAME_REGISTRY namespace に key=<game_id> で put。
//
// design.md §3.2 のゲーム追加フロー (register-game) の実体。詳細は docs/phase2-plan.md Step 1。
//
// 使い方:
//   CLOUDFLARE_DNS_API_TOKEN=xxx node scripts/register-game.mjs <game_id> [--dry-run]
//
// 環境変数:
//   CLOUDFLARE_DNS_API_TOKEN  必須。Zone:DNS:Edit 権限の API Token (Worker secret と同じもの)
//   CLOUDFLARE_ZONE_ID        省略時は workers/discord-handler/wrangler.toml の [vars] から読む
//   CLOUDFLARE_BASE_DOMAIN    省略時は同上
//   AWS 認証                  ローカル aws CLI に委譲 (aws s3 sync)
//   Cloudflare アカウント認証  ローカル wrangler に委譲 (wrangler kv key put)
//
// --dry-run: 実リソースを一切変更せず、実行する内容だけ表示する。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerDir = join(repoRoot, 'workers', 'discord-handler');
const CF_API = 'https://api.cloudflare.com/client/v4';

// ---- 引数 ----
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const gameId = args.find((a) => !a.startsWith('--'));
if (gameId === undefined) {
  fail('Usage: node scripts/register-game.mjs <game_id> [--dry-run]');
}

if (dryRun) log('--- DRY RUN (no resource will be changed) ---');

// ---- registry.json 読み込み + 最小バリデーション ----
const registryPath = join(repoRoot, 'games', gameId, 'registry.json');
if (!existsSync(registryPath)) {
  fail(`registry.json not found: ${registryPath}`);
}
const registryText = readFileSync(registryPath, 'utf8');
let registry;
try {
  registry = JSON.parse(registryText);
} catch (err) {
  fail(`registry.json is not valid JSON: ${err.message}`);
}
for (const field of ['game_id', 'subdomain', 'config_s3_prefix']) {
  if (typeof registry[field] !== 'string' || registry[field] === '') {
    fail(`registry.json is missing required field: ${field}`);
  }
}
if (registry.game_id !== gameId) {
  fail(`game_id mismatch: directory is "${gameId}" but registry.game_id is "${registry.game_id}"`);
}
if (registry.enabled === false) {
  log(`note: ${gameId} has "enabled": false — it will be registered but stay hidden from /list`);
}

// ---- 設定値の解決 (token は env、zone/domain は env or wrangler.toml) ----
// token は本実行では必須。--dry-run では未設定でも続行し、CF API を叩かずオフライン preview する。
const dnsToken = process.env.CLOUDFLARE_DNS_API_TOKEN;
if ((dnsToken === undefined || dnsToken === '') && !dryRun) {
  fail('Missing environment variable: CLOUDFLARE_DNS_API_TOKEN');
}
const wranglerToml = readFileSync(join(wranglerDir, 'wrangler.toml'), 'utf8');
const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? tomlVar(wranglerToml, 'CLOUDFLARE_ZONE_ID');
const baseDomain = process.env.CLOUDFLARE_BASE_DOMAIN ?? tomlVar(wranglerToml, 'CLOUDFLARE_BASE_DOMAIN');
const fqdn = `${registry.subdomain}.${baseDomain}`;

// KV 投入は wrangler.toml の GAME_REGISTRY binding に依存する (Phase 2 Step 3 で追加)。
// binding が無いうちに本実行すると失敗するため、先に検出して分かりやすく止める。
// 行頭アンカー必須 — コメントアウト中の `# binding = "GAME_REGISTRY"` を拾わないため。
const hasKvBinding = /^\s*binding\s*=\s*"GAME_REGISTRY"/m.test(wranglerToml);

console.log(`\n[register-game] ${gameId}`);
console.log(`  fqdn:     ${fqdn}`);
console.log(`  s3:       ${registry.config_s3_prefix}`);
console.log(`  zone:     ${zoneId}`);

// ---- ① Cloudflare DNS ----
console.log('\n[1/3] Cloudflare DNS');
const recordId = await ensureDnsRecord();
if (recordId !== undefined && registry.cf_record_id !== recordId) {
  if (dryRun) {
    log(`[dry-run] would write cf_record_id="${recordId}" into ${rel(registryPath)}`);
  } else {
    writeBackCfRecordId(recordId);
  }
} else if (recordId !== undefined) {
  log(`registry.json already has cf_record_id=${recordId} — no write-back needed`);
}

// ---- ② S3 config sync ----
console.log('\n[2/3] S3 config sync');
const configDir = join(repoRoot, 'games', gameId, 'config');
if (existsSync(configDir) && readdirSync(configDir).length > 0) {
  // .bak (検証用バックアップ) はアップロードしない
  run(['aws', 's3', 'sync', configDir, registry.config_s3_prefix, '--exclude', '*.bak']);
} else {
  log(`config/ is empty or missing — skip S3 sync`);
}

// ---- ③ Workers KV 投入 ----
console.log('\n[3/3] Workers KV (GAME_REGISTRY)');
if (!hasKvBinding) {
  if (dryRun) {
    log('[dry-run] GAME_REGISTRY binding not in wrangler.toml yet (added in Phase 2 Step 3)');
  } else {
    fail(
      'GAME_REGISTRY binding not found in wrangler.toml.\n' +
        'Complete Phase 2 Step 3 (create the KV namespace and add the binding) first.',
    );
  }
} else {
  // value は registry.json ファイルそのもの。先に cf_record_id を書き戻してあるので最新版が入る。
  run(
    [
      'wrangler', 'kv', 'key', 'put',
      '--binding', 'GAME_REGISTRY',
      '--remote',
      gameId,
      '--path', registryPath,
    ],
    wranglerDir,
  );
}

console.log(`\n✅ ${dryRun ? '[dry-run] ' : ''}register-game ${gameId} done.`);
if (!dryRun) {
  console.log('   Verify: /list (Discord) — KV 反映は最大 60 秒の伝播遅延あり');
}

// ============================================================
// helpers
// ============================================================

// 既存 A レコードがあれば id を返し、無ければ作成する (冪等)。
async function ensureDnsRecord() {
  if (dnsToken === undefined || dnsToken === '') {
    // --dry-run かつ token 未設定: CF API を叩かずオフライン preview。
    log(`[dry-run] would ensure A ${fqdn} exists (CF API not contacted: no CLOUDFLARE_DNS_API_TOKEN)`);
    return undefined;
  }
  const listUrl =
    `${CF_API}/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(fqdn)}`;
  const list = await cfFetch('listDnsRecords', listUrl);
  const existing = Array.isArray(list.result) ? list.result[0] : undefined;
  if (existing !== undefined) {
    log(`A ${fqdn} already exists (id=${existing.id}, content=${existing.content})`);
    return existing.id;
  }
  if (dryRun) {
    log(`[dry-run] would create: A ${fqdn} -> 0.0.0.0 (placeholder, Worker updates on /start)`);
    return undefined;
  }
  const created = await cfFetch('createDnsRecord', `${CF_API}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'A',
      name: fqdn,
      content: '0.0.0.0',
      ttl: 60,
      proxied: false,
      comment: `gs-${gameId} registered ${new Date().toISOString()}`,
    }),
  });
  log(`created: A ${fqdn} -> 0.0.0.0 (id=${created.result.id})`);
  return created.result.id;
}

// Cloudflare API を叩いて success を検証し、パース済み JSON を返す。
async function cfFetch(operation, url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${dnsToken}`, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${operation}: invalid JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok || parsed.success !== true) {
    const detail = Array.isArray(parsed.errors) && parsed.errors.length > 0
      ? parsed.errors.map((e) => `[${e.code}] ${e.message}`).join('; ')
      : `HTTP ${response.status}`;
    fail(`${operation} failed: ${detail}`);
  }
  return parsed;
}

// registry.json の cf_record_id の値だけを差し替える (空行などの整形は壊さない)。
function writeBackCfRecordId(recordId) {
  const re = /("cf_record_id"\s*:\s*)"[^"]*"/;
  if (!re.test(registryText)) {
    fail(`cf_record_id field not found in ${rel(registryPath)}`);
  }
  writeFileSync(registryPath, registryText.replace(re, `$1"${recordId}"`));
  log(`registry.json: cf_record_id = ${recordId}`);
}

// wrangler.toml の [vars] から VARNAME = "..." を取り出す。
function tomlVar(toml, name) {
  const m = toml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm'));
  if (m === null) {
    fail(`${name} not set (pass it as an env var or define it in wrangler.toml [vars])`);
  }
  return m[1];
}

// 外部コマンドを実行する。--dry-run なら表示のみ。
function run(argv, cwd) {
  const printable = argv.join(' ');
  if (dryRun) {
    log(`[dry-run] would run: ${printable}${cwd !== undefined ? `  (cwd: ${rel(cwd)})` : ''}`);
    return;
  }
  log(`$ ${printable}`);
  // Windows では aws/wrangler が .cmd のため shell 経由で起動する。
  execFileSync(argv[0], argv.slice(1), { stdio: 'inherit', cwd, shell: true });
}

function rel(p) {
  return p.startsWith(repoRoot) ? p.slice(repoRoot.length + 1) : p;
}

function log(msg) {
  console.log(`  ${msg}`);
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
