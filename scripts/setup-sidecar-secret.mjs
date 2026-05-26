// sidecar HMAC secret セットアップ自動化 (Phase 6 — phase3-plan.md L193 で予告した script)。
//
// 新ゲーム追加時に必要な 2 か所 (SSM + Wrangler secret JSON map) の整合を 1 コマンドで取る:
//   ① SSM SecureString `/gs/<game_id>/sidecar_hmac_secret` を作成 (既存ならスキップ)
//   ② SSM 上の全 `/gs/*/sidecar_hmac_secret` を列挙 → 値を取得 → JSON map を構築
//   ③ Wrangler secret `SIDECAR_HMAC_SECRETS` に map を投入 (常に最新状態に reconcile)
//
// 設計上のポイント:
//   - 冪等性: ① 既存 SSM secret は **上書きしない** (rerun safe)。③ map は常に全 game 再構築なので
//     Wrangler 側に欠落 / drift があっても自動修復される
//   - 単独 script: register-game.mjs と統合しない (phase3-plan.md 決定: 冪等性懸念 + secret セット
//     アップを毎回 register-game フローに混ぜる必然性が薄い)
//   - 秘密値はプロセス memory + AWS CLI 引数経由のみ。ファイル / 標準出力には平文を残さない
//     (--value 引数は ps aux で一時的に見えるが、local dev machine 前提のためトレードオフ容認)
//
// 使い方:
//   node scripts/setup-sidecar-secret.mjs <game_id> [--dry-run]
//
// 環境変数:
//   AWS_REGION              省略時 'ap-northeast-1'
//   CLOUDFLARE_API_TOKEN    Wrangler secret put 用 (OAuth login だと KV/secret write を蹴られる
//                           ケースがあるため API token を推奨。.secrets/credentials.env 等から)
//
// 前提:
//   - games/<game_id>/registry.json が存在 (register-game.mjs 済 = game が登録済)
//   - EC2 instance role が AmazonSSMManagedInstanceCore を持つ (sidecar が SSM を読める)
//   - wrangler.toml に SIDECAR_HMAC_SECRETS Wrangler secret が宣言済

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerDir = join(repoRoot, 'workers', 'discord-handler');
const SSM_PATH_PREFIX = '/gs/';
const SSM_PATH_SUFFIX = '/sidecar_hmac_secret';
const AWS_REGION_DEFAULT = 'ap-northeast-1';

// ---- 引数 ----
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const gameId = args.find((a) => !a.startsWith('--'));
if (gameId === undefined) {
  fail('Usage: node scripts/setup-sidecar-secret.mjs <game_id> [--dry-run]');
}

const awsRegion = process.env.AWS_REGION ?? AWS_REGION_DEFAULT;

// ---- registry.json 存在チェック (= game が register 済) ----
const registryPath = join(repoRoot, 'games', gameId, 'registry.json');
if (!existsSync(registryPath)) {
  fail(
    `games/${gameId}/registry.json not found — first run:\n` +
      `  node scripts/register-game.mjs ${gameId}`,
  );
}

console.log(
  `\n[setup-sidecar-secret] ${gameId} (region=${awsRegion}, ${dryRun ? 'DRY RUN' : 'LIVE'})`,
);

// ============================================================
// ① SSM put (既存なら skip)
// ============================================================
const ssmPath = `${SSM_PATH_PREFIX}${gameId}${SSM_PATH_SUFFIX}`;
console.log(`\n[1/3] SSM Parameter ${ssmPath}`);

const existing = ssmExists(ssmPath);
let createdNew = false;
if (existing) {
  log(`already exists — not overwriting (rerun-safe)`);
} else if (dryRun) {
  log(`[dry-run] would create CSPRNG base64 32-byte secret and put as SecureString`);
} else {
  // base64 32-byte = 44 chars (`=` 2 つで padding)。Worker 側の HMAC 検証も任意 base64 で動く。
  const newSecret = randomBytes(32).toString('base64');
  runAws([
    'ssm',
    'put-parameter',
    '--name',
    ssmPath,
    '--value',
    newSecret,
    '--type',
    'SecureString',
    '--region',
    awsRegion,
  ]);
  log(`created SecureString (length=${newSecret.length})`);
  createdNew = true;
}

// ============================================================
// ② SSM 全 `/gs/*/sidecar_hmac_secret` 列挙
// ============================================================
console.log(`\n[2/3] discovering all ${SSM_PATH_PREFIX}*${SSM_PATH_SUFFIX} parameters`);

const allPaths = listSsmHmacPaths();
const games = allPaths.map(extractGameFromPath).sort();
log(`found ${allPaths.length} game(s): ${games.length === 0 ? '(none)' : games.join(', ')}`);

if (!allPaths.includes(ssmPath)) {
  // dry-run で SSM 作成を skip した時の preview 用 placeholder
  if (dryRun) {
    allPaths.push(ssmPath);
    log(`[dry-run] including ${gameId} (would-be-created) for preview`);
  } else {
    fail(`SSM secret for ${gameId} not found after expected creation — investigate AWS state`);
  }
}

// ============================================================
// ③ JSON map 構築 + Wrangler secret put
// ============================================================
console.log(`\n[3/3] building SIDECAR_HMAC_SECRETS map for Wrangler`);

const map = {};
for (const path of allPaths.slice().sort()) {
  const game = extractGameFromPath(path);
  if (dryRun && path === ssmPath && !existing) {
    map[game] = '<would-be-created-base64-32-bytes>';
  } else {
    map[game] = ssmGetValue(path);
  }
}

const summary = Object.entries(map)
  .map(([g, v]) => `${g}=${maskSecret(v)}`)
  .join(', ');
log(`map: { ${summary} }`);

const mapJson = JSON.stringify(map);
if (dryRun) {
  log(`[dry-run] would pipe map JSON to: pnpm exec wrangler secret put SIDECAR_HMAC_SECRETS`);
  log(`[dry-run] map JSON length: ${mapJson.length} chars`);
} else {
  log(`putting SIDECAR_HMAC_SECRETS to Wrangler (game count=${Object.keys(map).length})`);
  try {
    // wrangler secret put は引数省略時 stdin から値を読む。pnpm 経由なので shell:true。
    execFileSync('pnpm', ['exec', 'wrangler', 'secret', 'put', 'SIDECAR_HMAC_SECRETS'], {
      cwd: wranglerDir,
      input: mapJson,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: true,
    });
  } catch (err) {
    fail(`wrangler secret put failed (exit ${err.status ?? '?'}): ${err.message}`);
  }
}

console.log(`\n✅ ${dryRun ? '[dry-run] ' : ''}setup-sidecar-secret ${gameId} done.`);
if (!dryRun && createdNew) {
  console.log(
    `   sidecar は --restart unless-stopped なので、次の retry で SSM 取得が通り Worker 認証まで進む想定。`,
  );
  console.log(`   確認: EC2 上で docker logs sidecar`);
}

// ============================================================
// helpers
// ============================================================

function ssmExists(name) {
  try {
    const out = execFileSync(
      'aws',
      [
        'ssm',
        'get-parameter',
        '--name',
        name,
        '--region',
        awsRegion,
        '--query',
        'Parameter.Name',
        '--output',
        'text',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: true },
    );
    return out.toString().trim() === name;
  } catch (err) {
    const stderr = err.stderr?.toString() ?? '';
    if (stderr.includes('ParameterNotFound')) return false;
    fail(`SSM get-parameter failed: ${stderr.trim() || err.message}`);
  }
}

function ssmGetValue(name) {
  try {
    const out = execFileSync(
      'aws',
      [
        'ssm',
        'get-parameter',
        '--name',
        name,
        '--with-decryption',
        '--region',
        awsRegion,
        '--query',
        'Parameter.Value',
        '--output',
        'text',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: true },
    );
    return out.toString().trim();
  } catch (err) {
    fail(
      `SSM get-parameter (with-decryption) failed for ${name}: ${err.stderr?.toString() ?? err.message}`,
    );
  }
}

function listSsmHmacPaths() {
  // describe-parameters の name filter で suffix を含むものを引く。
  // Contains は substring match なので、最後に /gs/*/sidecar_hmac_secret format で再 filter。
  try {
    const out = execFileSync(
      'aws',
      [
        'ssm',
        'describe-parameters',
        '--parameter-filters',
        `Key=Name,Option=Contains,Values=${SSM_PATH_SUFFIX}`,
        '--region',
        awsRegion,
        '--query',
        'Parameters[].Name',
        '--output',
        'json',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: true },
    );
    const names = JSON.parse(out.toString());
    return names.filter(
      (n) => n.startsWith(SSM_PATH_PREFIX) && n.endsWith(SSM_PATH_SUFFIX),
    );
  } catch (err) {
    fail(`SSM describe-parameters failed: ${err.stderr?.toString() ?? err.message}`);
  }
}

function extractGameFromPath(path) {
  return path.slice(SSM_PATH_PREFIX.length, -SSM_PATH_SUFFIX.length);
}

// log 表示用の masking。secret 値そのものは出さず、先頭 4 文字 + 長さ。
function maskSecret(value) {
  if (typeof value !== 'string' || value.length < 8) return '****';
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

function runAws(argv) {
  if (dryRun) {
    log(`[dry-run] would run: aws ${argv.join(' ').replace(/--value \S+/, '--value <hidden>')}`);
    return;
  }
  try {
    // --value に secret が混ざるため stdio:inherit にせず標準出力は捨てる (echo 抑止)。
    // 失敗時に stderr を残すため stderr のみ pipe → 失敗時に取り出す。
    execFileSync('aws', argv, { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  } catch (err) {
    fail(`aws ${argv[0]} ${argv[1]} failed: ${err.stderr?.toString().trim() ?? err.message}`);
  }
}

function log(msg) {
  console.log(`  ${msg}`);
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
