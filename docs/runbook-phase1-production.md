# Runbook — Phase 1 本番接続

最終更新: 2026-05-17

## このドキュメントについて

`runbook-phase1.md` の graceful stop 検証が通った後の **本番接続フェーズ** 手順。

Worker を Cloudflare に deploy し、Discord アプリと slash command を登録、AWS 側で SSM Parameter Store / S3 bucket / SNS topic / Budget alert を仕上げ、`/start atm11` → ATM11 起動 → プレイ → `/stop` のフルパスを実弾で確認する。

ゴール:

- [ ] Cloudflare Worker をデプロイし `pong` が公開 URL から返る
- [ ] Discord アプリ登録 + slash command 4 個登録 (`/list /start /stop /status`)
- [ ] Discord で `/start atm11` を叩いて ATM11 が起動し、Minecraft クライアントから接続できる
- [ ] `/stop` で graceful 停止、snapshot 作成、DNS が `0.0.0.0` に
- [ ] AWS Budget アラートが Discord に届く

所要時間: 3〜5 時間 (アカウント作業中心)。費用見込み: 月 ¥700 以下 (ATM11 50h プレイ想定)。

参照: [docs/design.md](design.md), [runbook-phase1.md](runbook-phase1.md), [ADR 0002](adr/0002-mc-stop-flow-docker-ssm.md)

---

## 前提

- `runbook-phase1.md` Step 1〜6 を完了済み (IAM ユーザー / SSM 経路 / nginx + ATM11 graceful stop)
- ローカルで `pnpm dev` + `pnpm typecheck` が通る
- Cloudflare に管理可能なドメインがある (例: `example.com`)
- Discord で Bot を追加できる server (= guild) がある

---

## Step 1: Cloudflare 周り

### 1.1 Cloudflare アカウント / ドメイン

Cloudflare 未登録なら https://dash.cloudflare.com/sign-up でアカウント作成。既存ドメインを Cloudflare に NS 移管するか、Cloudflare Registrar で取得。Zone ステータスが `Active` になるのを確認。

### 1.2 Wrangler ログイン

```powershell
cd F:\project\game_servers\workers\discord-handler
pnpm wrangler login
# ブラウザが開いて OAuth → 完了後 wrangler が token を保存
```

### 1.3 DNS A レコード作成 (atm11)

Cloudflare Dashboard → ドメイン → **DNS → Records**:

| Type | Name | Content | Proxy | TTL |
|---|---|---|---|---|
| A | `atm11` | `0.0.0.0` | DNS only (orange cloud OFF) | Auto |

> Worker が `/start` 時に content を実 IP に上書きする。**Proxy は必ず off** (game server は HTTP ではない)。

作成後、レコードを開いて **API → Get JSON** または右側 ID をコピー。これが `ATM11_CF_RECORD_ID`。

**Zone ID** は左側のドメイン Overview ページ右下にある (`CLOUDFLARE_ZONE_ID`)。

### 1.4 Cloudflare API Token 発行

https://dash.cloudflare.com/profile/api-tokens → **Create Token → Custom token**

- Permissions: `Zone` → `DNS` → `Edit`
- Zone Resources: `Include` → `Specific zone` → 対象ドメイン
- → **Continue to summary** → **Create Token**

表示された token をメモ (`CLOUDFLARE_DNS_API_TOKEN`)。

---

## Step 2: Discord アプリ登録 + slash command 登録

### 2.1 アプリ作成

https://discord.com/developers/applications → **New Application** → 名前 (例: `gs-bot`)

`General Information` ページで以下をメモ:
- **Application ID** → `DISCORD_APPLICATION_ID`
- **Public Key** → `DISCORD_PUBLIC_KEY`

### 2.2 Bot Token

左メニュー **Bot** → **Reset Token** → 表示された token をメモ (`DISCORD_BOT_TOKEN`)。
**Privileged Gateway Intents** は全部 off で OK (slash command は intents 不要)。

### 2.3 Bot を Guild に追加

左メニュー **OAuth2 → URL Generator**:
- Scopes: `bot`, `applications.commands`
- Bot Permissions: `Send Messages` (最低限)

生成された URL をブラウザで開き、対象 guild に Bot を招待。

### 2.4 Slash command 登録

```powershell
$env:DISCORD_BOT_TOKEN = '<bot-token>'
$env:DISCORD_APPLICATION_ID = '<app-id>'
$env:DISCORD_GUILD_ID = '<guild-id>'  # guild 右クリック → Copy Server ID (要 Developer Mode)
cd F:\project\game_servers
node scripts/register-discord-commands.mjs
# → /list /start /stop /status の 4 つが登録される
```

> guild 登録は即時反映、global 登録は最大 1 時間かかる。本番は global で `--global` フラグを付けて再実行。

Discord クライアントで対象 guild の入力欄に `/` を入れて `/list` が候補に出れば成功。

---

## Step 3: AWS 側の前準備

`runbook-phase1.md` の Step 1 (IAM ユーザー) と Step 2 (EC2 IAM role に SSM 権限) は完了済み前提。本番接続では Worker が EC2 / EBS を直接操作するので、追加で `gs-worker-caller-policy` を拡張する必要がある。

### 3.0 gs-worker-caller-policy に EC2 / EBS 権限を追加

IAM Console → **Policies → gs-worker-caller-policy → Edit** で以下の Statement を追加 (既存 SSM ステートメントの後ろに):

```json
{
  "Sid": "Ec2RunStopSnapshot",
  "Effect": "Allow",
  "Action": [
    "ec2:RunInstances",
    "ec2:TerminateInstances",
    "ec2:DescribeInstances",
    "ec2:DescribeVolumes",
    "ec2:DescribeSnapshots",
    "ec2:CreateSnapshot",
    "ec2:CreateTags"
  ],
  "Resource": "*"
}
```

> `Resource: *` は spot 起動時に AMI / subnet / SG など複数のリソース ARN が関わるため。本番運用では Condition で `aws:ResourceTag/Project=game-servers` を必須化することで影響を絞る (Phase 4 Terraform 化で対応)。

### 3.1 SSM Parameter Store に RCON password

```powershell
$pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
aws ssm put-parameter `
  --name /gs/atm11/rcon_password `
  --value $pw `
  --type SecureString `
  --region ap-northeast-1
# Worker / EC2 user-data が動的取得するためメモは不要 (記憶しても害はない)
```

### 3.2 S3 bucket 作成 + launcher tarball upload

```powershell
aws s3 mb s3://gs-game-configs --region ap-northeast-1
# bucket は default private、EC2 IAM の AmazonS3ReadOnlyAccess で GetObject 可

cd F:\project\game_servers
.\scripts\sync-launcher-to-s3.ps1 -GameId atm11
# → s3://gs-game-configs/launcher/atm11.tar.gz
```

> Dockerfile / entrypoint.sh / rcon-stop.sh を更新したら都度このスクリプトを再実行する。

### 3.3 ATM11 用 EBS snapshot ID 確認

`runbook-phase1.md` Step 5 で復元した volume の元 snapshot ID (Phase 0 で作った `phase0 verification snapshot`)、または `/stop` 検証時に取った新しい snapshot ID を控える。これが Worker の `ATM11_SNAPSHOT_ID` (seed)。

```powershell
aws ec2 describe-snapshots `
  --owner-ids self `
  --filters Name=tag:Game,Values=atm11 Name=status,Values=completed `
  --query "Snapshots[*].[SnapshotId,StartTime,Description]" `
  --output table `
  --region ap-northeast-1
```

### 3.4 SNS topic 作成

AWS Console → **Simple Notification Service → Topics → Create topic**:
- Type: **Standard**
- Name: `gs-alerts`
- Display name: `gs-alerts`
- → **Create topic**

作成された Topic ARN をメモ (`SNS_ALLOWED_TOPIC_ARN`)、例: `arn:aws:sns:ap-northeast-1:111111111111:gs-alerts`

### 3.5 Discord channel webhook 発行

Discord channel (通知投稿先) の **歯車 → Integrations → Webhooks → New Webhook** → URL コピー (`DISCORD_WEBHOOK_URL`)。

---

## Step 4: Worker secrets 投入 + デプロイ

### 4.1 secrets 投入

```powershell
cd F:\project\game_servers\workers\discord-handler

# Phase 1 検証用
pnpm wrangler secret put ADMIN_API_KEY

# AWS
pnpm wrangler secret put AWS_ACCESS_KEY_ID
pnpm wrangler secret put AWS_SECRET_ACCESS_KEY

# Discord
pnpm wrangler secret put DISCORD_PUBLIC_KEY
pnpm wrangler secret put DISCORD_APPLICATION_ID

# Cloudflare
pnpm wrangler secret put CLOUDFLARE_DNS_API_TOKEN

# AWS notification
pnpm wrangler secret put DISCORD_WEBHOOK_URL
```

### 4.2 wrangler.toml に vars 追加

secret ではない設定値は `wrangler.toml` の `[vars]` に置く (Phase 2 で KV 化予定):

```toml
[vars]
AWS_REGION = "ap-northeast-1"
CLOUDFLARE_ZONE_ID = "<your-zone-id>"
CLOUDFLARE_BASE_DOMAIN = "example.com"
EC2_SUBNET_ID = "subnet-xxxxxxxx"
EC2_SECURITY_GROUP_ID = "sg-xxxxxxxx"
EC2_KEY_NAME = "gs-phase0-key"
EC2_IMAGE_ID = "resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
EC2_INSTANCE_PROFILE_NAME = "gs-phase0-ec2-role"
ATM11_SNAPSHOT_ID = "snap-xxxxxxxx"
ATM11_CF_RECORD_ID = "<dns-record-id>"
ATM11_RCON_PASSWORD_SSM_PATH = "/gs/atm11/rcon_password"
LAUNCHER_TARBALL_S3_URI = "s3://gs-game-configs/launcher/atm11.tar.gz"
SNS_ALLOWED_TOPIC_ARN = "arn:aws:sns:ap-northeast-1:111111111111:gs-alerts"
```

### 4.3 デプロイ

```powershell
pnpm wrangler deploy
# → https://discord-handler.<account>.workers.dev/ にデプロイ
```

URL をメモ (Discord 設定で使う)。

### 4.4 smoke test

```powershell
curl.exe https://discord-handler.<account>.workers.dev/ping
# → pong

curl.exe https://discord-handler.<account>.workers.dev/health
# → {"status":"ok",...}
```

### 4.5 Discord Interactions Endpoint URL を設定

https://discord.com/developers/applications → アプリ → **General Information**
- **Interactions Endpoint URL**: `https://discord-handler.<account>.workers.dev/discord/interaction`
- **Save Changes** → Discord 側が PING を送信して 200 + `{"type":1}` を受信したら緑チェックが付く

> ed25519 検証が通らないと "Failed to verify" でエラー、Public Key が secret 経由で正しく入っているか確認。

---

## Step 5: SNS topic を Worker に subscribe

### 5.1 subscription 作成

AWS Console → SNS → **Topics → gs-alerts → Create subscription**:
- Protocol: **HTTPS**
- Endpoint: `https://discord-handler.<account>.workers.dev/aws/notification`
- → **Create subscription**

SNS は自動で `SubscriptionConfirmation` を投げる。Worker が SubscribeURL を GET して自動承認 → subscription status が `Confirmed` になる (確認まで 5〜15 秒)。

### 5.2 テスト publish

```powershell
aws sns publish `
  --topic-arn arn:aws:sns:ap-northeast-1:111111111111:gs-alerts `
  --subject "Phase 1 test notification" `
  --message "本番接続 smoke test (info severity)" `
  --region ap-northeast-1
```

→ Discord channel (DISCORD_WEBHOOK_URL の channel) に緑色 ℹ️ embed が届く。

### 5.3 Budget alert を SNS に切り替え

AWS Console → **AWS Budgets → 既存 Budget (or 新規作成) → Alert thresholds**:
- Notification type: **Amazon SNS topic**
- SNS topic ARN: `arn:aws:sns:ap-northeast-1:111111111111:gs-alerts`
- → Save

> Budget の SNS subscribe には bucket policy で SNS 経由で AWS Budgets サービスからの publish を許可する必要がある。Console から設定する場合は自動で policy が更新される。

---

## Step 6: フルパス実弾検証

### 6.1 `/list`

Discord で `/list` → 即時返答で `atm11` が含まれる:

```
**Game servers**
- `atm11` — All The Mods 11 (atm11:25565)
```

### 6.2 `/start atm11`

Discord で `/start game:atm11`:

1. 即時返答: `⏳ ATM11 を起動中...初回ロードは40〜60秒かかります`
2. 数秒後: `⏳ snapshot 確定: latest snap-xxx (timestamp)、EC2 起動中…`
3. ~60 秒後: `⏳ EC2 i-xxx 起動中… (running + public IP 待ち)`
4. ~30 秒後: `✅ ATM11 起動完了! atm11.example.com:25565 で接続できます`

container 起動 (image build 1-2 分 + MC bootstrap 60秒) を含めて 3-4 分後に Minecraft クライアントから `atm11.example.com:25565` で接続できる。

### 6.3 動作確認

- Minecraft クライアントで接続して 5 分プレイ
- ブロックを設置して座標をメモ

### 6.4 `/status`

Discord で `/status`:

```
**Running game servers**
- `i-xxx` — running — `1.2.3.4`
```

### 6.5 `/stop`

Discord で `/stop`:

1. `⏳ atm11 を停止中…`
2. `⏳ docker stop 発火: cmd-id 完了待ち…`
3. `⏳ snapshot snap-yyy 作成中 (AWS 側で async 完了)、terminate に進みます…`
4. `✅ ATM11 を停止しました。次回起動まで世界は保存されています\nsnapshot: snap-yyy (進行中、次回 /start で使用)`

確認:
- AWS Console で EC2 が `Terminated`
- EBS Snapshots に新しい snapshot が `pending` → `completed`
- DNS record の content が `0.0.0.0` に書き換わっている
- 元の volume は Available 状態で残る (Phase 2 cron で自動削除予定、現状は手動)

### 6.6 再起動で world 永続性確認

5〜10 分待って snapshot が completed になったのを確認後、再度 `/start atm11`。
Minecraft クライアントで接続 → 前回設置したブロックが残っていることを確認。

---

## Step 7: 後片付け / 運用モード

### 通常運用

- Discord で `/start atm11` → プレイ → `/stop` で開始終了
- 月のプレイ時間 (50h 想定) で AWS 費用 ¥700 以下
- Cloudflare Worker は無料枠内
- Budget alert が ¥3000 で発火 → Discord で確認

### 累積 Available volume の削除

`/stop` 後の旧 volume は手動削除が必要 (Phase 2 で cron 自動化):

```powershell
aws ec2 describe-volumes `
  --filters Name=tag:Game,Values=atm11 Name=status,Values=available `
  --query "Volumes[*].[VolumeId,CreateTime,Size]" `
  --output table `
  --region ap-northeast-1

# 古いものから削除
aws ec2 delete-volume --volume-id vol-xxxxxxxx --region ap-northeast-1
```

### snapshot 世代管理 (Phase 4 で DLM 化)

現状は累積するので、定期的に古いものを手動削除:

```powershell
aws ec2 describe-snapshots `
  --owner-ids self `
  --filters Name=tag:Game,Values=atm11 `
  --query "sort_by(Snapshots, &StartTime)[*].[SnapshotId,StartTime]" `
  --output table `
  --region ap-northeast-1

aws ec2 delete-snapshot --snapshot-id snap-xxxxxxxx --region ap-northeast-1
```

3 世代より古いものを削除する運用。

---

## Troubleshoot

### Discord で `/start` が "Application did not respond"

- Worker が 3 秒以内に応答していない
- `pnpm wrangler tail` で本番ログを確認、エラーがあれば該当箇所を修正

### `/start` 後 EC2 は立つが container が起動しない

- EC2 にログイン: `ssh -i .secrets/gs-phase0-key.pem ec2-user@<ip>`
- user-data ログ: `sudo cat /var/log/gs-userdata.log`
- よくある原因:
  - S3 から launcher tarball が取れない → IAM role 確認、bucket policy
  - SSM Parameter Store から RCON pw が取れない → param 名が一致するか
  - docker build 失敗 → AL2023 で Docker daemon が起動しているか

### Cloudflare DNS 更新が反映されない

- Cloudflare API Token の権限が `Zone:DNS:Edit` か
- DNS record の Proxy が off (DNS only) になっているか (Proxy on だと A レコード差し替えが効かない)

### SNS subscription confirm が成功しない

- Worker の `/aws/notification` が 200 を返しているか (`wrangler tail` で確認)
- TopicArn allow list (`SNS_ALLOWED_TOPIC_ARN`) が一致しているか

### EBS snapshot / EC2 操作が UnauthorizedOperation

- Step 3.0 の `Ec2RunStopSnapshot` ステートメントを policy に追加し忘れている可能性
- IAM Console → Policies → gs-worker-caller-policy で内容を確認、不足アクションを追加

---

## Phase 1 完了条件

- [ ] Discord `/list` → ATM11 が候補に出る
- [ ] Discord `/start atm11` → 3〜4 分で接続可能になる
- [ ] Minecraft クライアントで接続して 5 分プレイ + ブロック設置
- [ ] Discord `/stop` → graceful stop、snapshot 作成、DNS が `0.0.0.0`
- [ ] 再度 `/start atm11` で前回の world が読み込まれる
- [ ] `aws sns publish` で送ったテスト notification が Discord に届く
- [ ] AWS Budget アラートを SNS 経由に切り替え、threshold $15 設定で確認可能
- [ ] 月コスト試算が ¥700 以内に収まる見込み

すべて満たせば Phase 1 ゴール達成。Phase 2 (Workers KV / registry-driven / 2 個目ゲーム追加) に進める。
