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

## Step 5: AMI 焼き込み (Phase 3 plan の Step 7)

### 5.1 前提ツールの確認

```powershell
packer version       # >= 1.11
docker --version     # Docker Desktop (Windows) が動いている
terraform version    # >= 1.10
aws sts get-caller-identity --region ap-northeast-1
```

### 5.2 Packer 用 IAM 権限

Phase 1 で作った IAM ユーザー (例 `gs-deployer`) で動かす想定。Packer は temporary
keypair / SG / EC2 / snapshot を作るため、最低限 EC2 系の AMI 作成権限が要る。Phase 3
スコープでは AdministratorAccess を持つユーザーで初回 build → 動いたら最小権限 policy に
絞るのが現実的。Packer 公式の最小 policy は
<https://developer.hashicorp.com/packer/integrations/hashicorp/amazon#iam-task-or-instance-role>
を参照。

### 5.3 Terraform で AMI 参照経路を切替 (1 回限り)

`infra/envs/prod/ami.tf` (新規) と `infra/envs/prod/compute.tf` の `image_id` を変更済。
これを apply して **SSM Parameter `/gs/ami/game-server-latest` を作り、Launch Template の
image_id を `resolve:ssm:` 参照に切替** する。

```powershell
cd F:\project\game_servers\infra
.\tf.ps1 plan '-out=phase3-ami.tfplan'
# 差分の例:
#   + aws_ssm_parameter.game_server_ami_id  (新規、初期値 = AL2023 公式 AMI ID)
#   ~ aws_launch_template.game_server.image_id  ("resolve:ssm:/aws/service/..." -> "resolve:ssm:/gs/ami/...")
```

> **注**: `tf.ps1` は `infra/` 直下にある(中で自動的に `-chdir=envs/prod` する)。`envs/prod` に
> cd してはいけない。
>
> **注**: `-out=...` 引数は **シングルクォートで囲む**。PowerShell 7.x は引用符なしだと
> `-out=phase3-ami.tfplan` を `.` で分割して 2 引数として渡してしまい、terraform が
> "Too many command line arguments" で落ちる。

差分が **その 2 件だけ** であることを目視確認してから apply:

```powershell
.\tf.ps1 apply 'phase3-ami.tfplan'
```

> apply 直後は SSM Parameter の値が AL2023 公式 AMI ID なので、Packer build 前でも
> Worker からの `/start` は引き続き AL2023 base AMI で動く (sidecar tar は無いが
> user-data に「tar が無ければ skip」の分岐がある = Phase 3 Step 6 で実装済)。

### 5.4 sidecar AMI を build

```powershell
cd F:\project\game_servers
.\scripts\build-sidecar-ami.ps1
# 約 5〜10 分。最後に "Builds finished. The artifacts ..." と AMI ID (ami-xxxxxxxx) が表示される。
```

出力の例:

```
==> Builds finished. The artifacts of successful builds are:
--> gs-game-server.amazon-ebs.gs_game_server: AMIs were created:
ap-northeast-1: ami-0abcd1234ef567890
```

### 5.5 SSM Parameter に新 AMI ID を書き込む

```powershell
$amiId = "ami-0abcd1234ef567890"  # ↑ Packer の出力からコピー
aws ssm put-parameter `
  --name /gs/ami/game-server-latest `
  --value $amiId `
  --type String `
  --overwrite `
  --region ap-northeast-1
```

確認:

```powershell
aws ssm get-parameter --name /gs/ami/game-server-latest --region ap-northeast-1 --query "Parameter.Value" --output text
# → ami-0abcd1234ef567890
```

> 次の `/start` から自動でこの AMI が使われる (LT が `resolve:ssm:` で起動時解決するため
> terraform apply 不要)。

### 5.6 動作確認 (任意)

新 AMI で 1 台空 EC2 を立てて、sidecar tar が同梱されているか確認するなら:

```powershell
# 確認用に Launch Template の latest version で 1 台起動 (subnet は default の好きなものに置換)
aws ec2 run-instances `
  --launch-template "LaunchTemplateName=gs-game-server,Version=`$Latest" `
  --subnet-id <YOUR_SUBNET_ID> `
  --instance-type m7a.large `
  --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=game-servers},{Key=Purpose,Value=ami-smoke}]" `
  --region ap-northeast-1
# → public IP を確認、SSH ログインして:
#   ls -la /var/lib/sidecar-image.tar
#   sudo docker load -i /var/lib/sidecar-image.tar
#   sudo docker images   # gs-sidecar:latest が出る
```

確認後は `aws ec2 terminate-instances --instance-ids ...` で停止。本格的な ATM11 起動・停止
確認は Step 8 で行う (本書のスコープ外)。

## Step 6: デプロイ + ATM11 実機確認 (Phase 3 plan の Step 8)

Worker / sidecar / AMI / Secrets がすべて揃ったらここで本番反映 + 実機テスト。これが Phase 3
のゴール「ATM11 を放置で勝手に停止」の最終検証。

### 6.1 Worker をデプロイ

```powershell
cd F:\project\game_servers\workers\discord-handler
pnpm deploy
```

期待出力:
- "Your worker has access to the following bindings:" に **SERVER_STATE / GAME_REGISTRY**
  (KV) と **WORKER_PUBLIC_URL** (vars) が出る
- `pnpm wrangler secret list` で `SIDECAR_HMAC_SECRETS` が出る (deploy 時には表示されない)
- "Published" 行に Worker URL が表示される

> 失敗例 — `Missing binding: SIDECAR_HMAC_SECRETS`: Step 2 が未実行。`pnpm wrangler secret put SIDECAR_HMAC_SECRETS` を先に。

### 6.2 別シェルで `wrangler tail` を起動

```powershell
cd F:\project\game_servers\workers\discord-handler
pnpm wrangler tail
```

Phase 3 で追加した経路のログが流れる。本 Step で観察すべきパターン:
- `[stop-workflow] ...` — Discord `/stop` / sidecar / cron-fallback いずれの経路でも出る
- `[sidecar idle-detected] atm11 ...` — sidecar 経由 idle 通知
- `[idle-fallback] atm11 ...` — Cron フォールバック (5 分 cron)
- `sidecar heartbeat rejected: ...` — HMAC 不整合 (Step 1/2 の secret 取り違え疑い)

### 6.3 `/start atm11` で sidecar 経路が動くことを観察

Discord で `/start atm11` 実行。期待される流れ:

1. Discord 応答 `🚀 ATM11 を起動しています…` (3 秒以内)
2. wrangler tail に EC2 起動 / EBS mount / docker run / SNS ready 通知 系のログ
3. **sidecar が立ち上がる** = `POST /sidecar/heartbeat` が 204 で 1 分間隔
4. Discord に ready 通知 `✅ ATM11 接続可能になりました ...`

KV を直接覗いて sidecar の last_seen を確認:

```powershell
pnpm wrangler kv key get 'last-seen:atm11' --binding SERVER_STATE
# 注: wrangler kv key get/put は本番 KV がデフォルト。`--remote` フラグは存在しない (3.x で
# 確認、`Unknown argument: remote` で落ちる)。ローカルを指定する時だけ `--local` を付ける。
# → {"gameId":"atm11","instanceId":"i-...","lastSeenAt":"2026-05-23T...","playerCount":-1 or 0}
```

> 起動直後は RCON が立ち上がるまで `playerCount: -1` (adapter 失敗の保守値) が続く。
> ATM11 ready 後は 0 (誰も接続していない) になる。

### 6.4 通常 idle 経路の検証 (sidecar 発火)

1. Minecraft クライアントで 1 人接続 → 数分プレイ → 切断
2. **10 分待つ** (`atm11.idle_check.timeout_min: 10`)
3. wrangler tail で順に観察:
   - `[stop-workflow] ⏳ docker stop 発火: ...`
   - `[sidecar idle-detected] atm11 (expected=i-...): {"status":"ok",...}`
   - `[stop-workflow] ⏳ snapshot ... 作成中`
   - terminate / DNS reset / pending cleanup 登録
4. AWS console で EC2 が `terminated` に、game-world snapshot が新規作成されていることを確認

### 6.5 Cron フォールバック経路の検証 (sidecar 強制停止)

sidecar を意図的に殺して、Cron が代わりに stop することを見る:

1. Discord で `/start atm11` (新しい instance を起動、ready 待ち)
2. AWS SSM Session Manager で EC2 にログイン (or SSH):
   ```bash
   sudo docker stop sidecar
   sudo docker rm sidecar    # `--restart unless-stopped` で蘇生しないよう削除
   ```
3. **約 15 分待つ** (`timeout_min` 10 + Cron フォールバック skew 5)。Cron は 5 分ごとなので
   ぴったり 15 分ではなく次の 5 分境界で発火 → 最大 20 分かかる
4. wrangler tail で順に観察:
   - `[idle-fallback] atm11 silent for 15 min (threshold 15 min). forcing stop.`
   - `[stop-workflow] ... (cron-fallback)`
5. EC2 が terminate される

### 6.6 grace 期間で誤停止しない確認

Cron フォールバックは `last_seen` キーが無ければ skip する。起動直後の grace で誤発火しない
ことを確認:

1. (上の 6.5 を実行した直後 = `last-seen:atm11` キーが TTL 切れか KV から消えている状態)
2. **sidecar を立てずに** atm11 だけ手動起動するシナリオを再現するのは煩雑なので、ログ観察で代替:
   - wrangler tail を起動した状態で次の Cron まで待つ
   - `[idle-fallback]` のログが出ないこと (`skip (no-heartbeat)` は `console.log` を抑制してあるため出ない設計、stop workflow も発火しないことだけが要件)
3. **stop workflow が発火していない** ことを確認 (= EC2 が terminate されない)

### 6.7 world 永続性の回帰

1. 6.4 (or 6.5) で stop した直後に Discord で `/start atm11`
2. Minecraft クライアントで接続 → **前回プレイした地点に居る**、設置したブロックが残っている
3. これが通れば Step 1〜7 の通り snapshot → 新 volume 復元の経路が壊れていない

### 6.8 Discord 手動 `/stop` の回帰

Phase 1 の経路を壊していないことを確認:

1. Discord で `/start atm11`
2. ready 後すぐに Discord で `/stop atm11` (手動)
3. wrangler tail に `[stop-workflow] ... (discord)` が出る (`triggeredBy: 'discord'`)
4. Discord に `✅ ATM11 を停止しました …` と完了通知

### Phase 3 完了基準 (本 Step で green にする)

`docs/phase3-plan.md` の **完了基準** セクションのチェックボックスを順次埋める:

- [ ] ATM11 で `/start` 後にプレイヤー 0 状態を 10 分続けると、手動 `/stop` 無しで snapshot + terminate が走る (6.4)
- [ ] sidecar 強制停止後も Cron フォールバックが ~15 分後に EC2 を停止する (6.5)
- [ ] `/start` 直後の grace で誤停止しない (6.6)
- [ ] Discord `/stop` が引き続き動く (6.8)
- [ ] world 永続性 (6.7)

すべて緑になったら Step 9 (ドキュメント更新 + Phase 3 完了マーク、`docs/phase3-plan.md`) に進む。

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

## Phase 3 Step 5 / 6 / 7 完了条件

- [x] **Step 5 (sidecar HMAC secret)**:
  - `aws ssm get-parameter --name /gs/atm11/sidecar_hmac_secret` が値を返す
  - `pnpm wrangler secret list` の出力に `SIDECAR_HMAC_SECRETS` が含まれる
  - 投入した base64 secret は `docs/.secrets/` 等の **gitignore された場所** にバックアップ
- [x] **Step 6 (WORKER_PUBLIC_URL)**:
  - `wrangler.toml` の `WORKER_PUBLIC_URL` が実 Worker URL に書き換えられている
  - `pnpm build` (Worker dry-run) の bindings 一覧に `WORKER_PUBLIC_URL` が出る
- [x] **Step 7 (Packer AMI build)**:
  - `terraform apply` で `aws_ssm_parameter.game_server_ami_id` が作成され、Launch Template
    の image_id が `resolve:ssm:/gs/ami/game-server-latest` に切り替わっている
  - `scripts/build-sidecar-ami.ps1` 実行が成功し、Packer が AMI ID を発行している
  - `aws ssm get-parameter --name /gs/ami/game-server-latest` が新 AMI ID (`ami-xxx`) を返す
  - 任意の smoke check: 新 AMI から立ち上げた EC2 に `/var/lib/sidecar-image.tar` が存在する
