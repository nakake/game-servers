# Runbook — Phase 3 sidecar secrets (SSM + Wrangler)

最終更新: 2026-05-23

## このドキュメントについて

`docs/phase3-plan.md` **Step 5** の手順書。sidecar (EC2 内 Node コンテナ) が Worker
`/sidecar/*` を呼ぶための **HMAC 共有秘密** を game ごとに発行し、AWS SSM SecureString と
Cloudflare Wrangler secret の **両側** に同じ値を投入する。

実行はユーザーが手元の PowerShell から行う。本書はコマンド集 + 確認手順 + ローテーションの
運用ガイド。

参照:
- [docs/phase3-plan.md](phase3-plan.md) 決定4 / 決定10 (HMAC 仕様) / 決定11 (重複発火防止)
- [docs/runbook-phase1-production.md](runbook-phase1-production.md) §3.1 (SSM SecureString の流儀)
- `workers/discord-handler/src/env.ts` `SIDECAR_HMAC_SECRETS`
- `launcher/sidecar/src/main.ts` `getSecureParameter` 呼び出し

## 前提

- `runbook-phase1-production.md` を完了済 (AWS CLI / Wrangler が認証済、`/gs/atm11/rcon_password`
  が既に SSM に存在する)
- 作業マシンは Windows + PowerShell 7+。AWS CLI v2 と Node.js 22 が PATH 上にある
- リージョン: `ap-northeast-1`
- 対象ゲーム: ATM11 (`atm11`)。他ゲームの追加手順は本書末尾の §新ゲーム追加に従う

## IAM 権限 (確認のみ、追加不要)

EC2 instance role (`gs-game-server` Launch Template の IAM profile) は `AmazonSSMManagedInstanceCore`
を持っているため、`ssm:GetParameter` + `kms:Decrypt` 経由で `/gs/<game>/sidecar_hmac_secret`
の SecureString を取得できる。Phase 1 で `/gs/atm11/rcon_password` を読めている経路と同じ。
**Phase 3 で IAM の追加変更は要らない**。

## Step 1: SSM SecureString に sidecar HMAC secret を投入

ランダムな 32 byte (256 bit) を base64 化して投入する。Cryptographic に安全な乱数源を使う
(PowerShell の `Get-Random` は CSPRNG ではないため、`System.Security.Cryptography` を直接使う)。

```powershell
# 32 byte ランダムを CSPRNG で生成し base64 化
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$sidecarSecret = [Convert]::ToBase64String($bytes)
# 確認 (44 文字の base64 が出る)
$sidecarSecret.Length

# SSM SecureString に投入。Phase 1 と同じ /gs/<game_id>/ プレフィクス。
aws ssm put-parameter `
  --name /gs/atm11/sidecar_hmac_secret `
  --value $sidecarSecret `
  --type SecureString `
  --region ap-northeast-1
```

> **重要**: `$sidecarSecret` の値は **Worker secret 投入が終わるまで** 同じ PowerShell
> セッションに保持する。終了すると失効するが、SSM 側を `--overwrite` で再投入する手は使える
> (sidecar / Worker の両側で再投入が必要)。

確認:

```powershell
aws ssm get-parameter `
  --name /gs/atm11/sidecar_hmac_secret `
  --with-decryption `
  --region ap-northeast-1 `
  --query "Parameter.Value" `
  --output text
# → $sidecarSecret と同じ文字列が表示されれば OK
```

## Step 2: Wrangler secret `SIDECAR_HMAC_SECRETS` に同じ値を投入

Worker 側は **game→secret の JSON map** を 1 個の secret に入れる (`docs/phase3-plan.md` 決定4)。
初回は atm11 のみ。

```powershell
cd F:\project\game_servers\workers\discord-handler

# JSON map を組み立て (atm11 のみ初期投入)。Step 1 の $sidecarSecret をそのまま使う。
$payload = @{ atm11 = $sidecarSecret } | ConvertTo-Json -Compress
$payload
# → {"atm11":"....."} と表示

# wrangler secret put は stdin から受け取る。
$payload | pnpm wrangler secret put SIDECAR_HMAC_SECRETS
```

> `wrangler secret put` は対話モードなら標準入力プロンプトを出すが、`echo / Out-Pipe` で
> 流し込めば非対話で投入できる (PowerShell の `|` が stdin に渡る挙動)。

確認:

```powershell
pnpm wrangler secret list
# → SIDECAR_HMAC_SECRETS (Encrypted) が表示されれば OK。値は表示されない。
```

## Step 3: Worker URL を `wrangler.toml` に反映 (Phase 3 Step 6 のプリチェック)

`wrangler.toml` の `[vars] WORKER_PUBLIC_URL` には placeholder
(`https://discord-handler.<your-account>.workers.dev`) が入っている。**実際の Worker URL**
(初回 deploy 出力に表示される `https://<worker-name>.<account>.workers.dev`) に書き換える。

```powershell
cd F:\project\game_servers\workers\discord-handler

# 既に Phase 1 で deploy 済なら現在の URL を確認
pnpm wrangler deployments list | Select-Object -First 5
# Worker URL の形式: https://discord-handler.<your-account>.workers.dev
```

`workers/discord-handler/wrangler.toml` を編集し、`WORKER_PUBLIC_URL` を実 URL に書き換え。

## Step 4: Worker build (dry-run) で全 bindings 確認

```powershell
pnpm build
# → "Your worker has access to the following bindings:" に以下が並ぶこと:
#   - KV: SERVER_STATE, GAME_REGISTRY
#   - Vars: ..., WORKER_PUBLIC_URL = "<実 URL>"
#   secrets は ここには出ないが pnpm wrangler secret list で SIDECAR_HMAC_SECRETS を確認済 (Step 2)。
```

## Step 5: 動作確認 (Step 8 で再テストするので軽め)

実機の動作確認は Step 8 (デプロイ + ATM11 実機確認) で行う。本 Step では「投入できた」
だけを確認する。

## 新ゲーム追加時の手順 (将来 Phase 6 で参照)

新ゲーム `<game>` を追加するときは:

1. **SSM**: `/gs/<game>/sidecar_hmac_secret` を Step 1 と同じ流れで投入 (game ごとに独立な secret)
2. **Wrangler secret**: `SIDECAR_HMAC_SECRETS` を **既存値を保持したまま新 game の key を追加**
   して再投入。流れ:

   ```powershell
   # 現在の secret の値を取得する API は Wrangler に無いので、初回 Step 2 で投入した
   # JSON 全体を手元で保持しておくか、`docs/.secrets/` の管理外メモに残しておく必要がある。
   # 失った場合は **全 game の secret を再生成 + SSM 再投入 + JSON 再構築** が要る。
   $payload = @{
     atm11   = $atm11SidecarSecret
     vanilla = $vanillaSidecarSecret
   } | ConvertTo-Json -Compress
   $payload | pnpm wrangler secret put SIDECAR_HMAC_SECRETS
   ```

3. **新ゲーム sidecar を起動**: cloud-init の `docker run` で `-e GAME_ID=<game>` を渡せば
   sidecar が SSM `/gs/<game>/sidecar_hmac_secret` を読み Worker `/sidecar/registry` で
   認証される

> Phase 3 では atm11 一個。Phase 6 (新ゲーム追加実証) で実際に複数ゲームを足す段階で、上記
> JSON ローテーションの面倒くささが顕在化したら `scripts/setup-sidecar-secret.mjs` のような
> ヘルパースクリプトを検討する。register-game.mjs への統合は **行わない**
> (`docs/phase3-plan.md` Step 5 / Open Questions で確定 2026-05-23)。

## ローテーション

万一 secret が漏洩した / IAM 監査でローテーションが必要になった場合の手順:

1. Step 1 で **同じパス** に `--overwrite` フラグ付きで再投入 (新乱数を生成):

   ```powershell
   aws ssm put-parameter `
     --name /gs/atm11/sidecar_hmac_secret `
     --value $newSidecarSecret `
     --type SecureString `
     --overwrite `
     --region ap-northeast-1
   ```

2. Step 2 と同じ流れで `SIDECAR_HMAC_SECRETS` 全体を再投入 (該当 game の key だけ新値に置換)

3. **稼働中の sidecar / Worker は反映タイミングが異なる**:
   - Worker は次回 invocation で新値を読む (即時)
   - sidecar は **起動時に SSM を 1 回しか読まない**実装 (`launcher/sidecar/src/main.ts`)。
     既稼働 sidecar は古い secret を使い続け、次回 `/start` (= 新 EC2 起動 + sidecar 新規) で
     新値を読む
   - ローテーション後にすぐ反映したい場合は Discord `/stop atm11` → 既稼働 EC2 を一度落として
     `/start atm11` で新 secret を持つ sidecar を起動する

## 失敗時のトラブルシュート

### `wrangler secret put` で "Authentication error"

`pnpm wrangler login` でブラウザ認証を再実行。

### Worker デプロイで `Missing required binding: SIDECAR_HMAC_SECRETS`

Step 2 が完了していない。`pnpm wrangler secret list` で確認。

### sidecar が `SSM parameter "/gs/atm11/sidecar_hmac_secret" not found or empty` で exit

Step 1 が完了していない、もしくは region が違う (`ap-northeast-1` 以外で投入していないか)。

### sidecar の `/sidecar/heartbeat` が 401 を返し続ける

SSM 側と Wrangler 側の secret 値が **完全一致** していない。両方を再投入 (Step 1 → Step 2 を
**同じ `$sidecarSecret` 変数** で連続実行) して合わせる。あるいは Worker の
`SIDECAR_HMAC_SECRETS` JSON で game_id のキー名 typo が無いか確認 (atm11 / Atm11 等)。

## Phase 3 Step 5 / 6 完了条件

- [ ] `aws ssm get-parameter --name /gs/atm11/sidecar_hmac_secret` が値を返す (Step 5)
- [ ] `pnpm wrangler secret list` の出力に `SIDECAR_HMAC_SECRETS` が含まれる (Step 5)
- [ ] `wrangler.toml` の `WORKER_PUBLIC_URL` が実 Worker URL に書き換えられている (Step 6)
- [ ] `pnpm build` (Worker dry-run) の bindings 一覧に `WORKER_PUBLIC_URL` が出る (Step 6)
- [ ] 投入した base64 secret は `docs/.secrets/` 等の **gitignore された場所** にバックアップ
      (新ゲーム追加時の JSON 再構築用、§新ゲーム追加 §2 参照)
