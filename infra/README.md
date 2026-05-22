# infra — AWS Terraform

AWS リソースを Terraform で宣言的に管理する (`prod` 環境のみ、リージョン `ap-northeast-1`)。

Phase 1 の手動コンソール作業で silent fail が頻発したのを受け、design.md §10 Phase 4 を前倒しして手動リソースを段階的に IaC 化した (IaC 移行 Step 0〜8 完了)。経緯・Step ごとの設計判断・Open Questions は [docs/iac-migration-plan.md](../docs/iac-migration-plan.md) に集約。本 README は「`infra/` に今あるものの説明」に絞る。

## ディレクトリ

```
infra/
├─ tf.ps1               # terraform ラッパ (AWS 認証ブリッジ + envs/prod への -chdir)
├─ envs/
│  └─ prod/             # 本番環境 (現状唯一)
│     ├─ versions.tf    # terraform / aws provider バージョン
│     ├─ providers.tf   # region + default_tags
│     ├─ backend.tf     # S3 リモート backend (S3 ネイティブロック)
│     ├─ variables.tf
│     ├─ iam.tf         # EC2 role + instance profile, gs-worker-caller user/policy
│     ├─ network.tf     # Security Group + rules (default VPC/Subnet は data 参照)
│     ├─ compute.tf     # Launch Template, Key Pair (data 参照)
│     ├─ storage.tf     # S3 bucket gs-game-configs (versioning + lifecycle + SSE)
│     ├─ sns.tf         # gs-alerts topic + policy + Worker HTTPS subscription
│     ├─ budgets.tf     # 月次コスト上限アラート
│     ├─ eventbridge.tf # Spot 中断警告 rule → SNS
│     ├─ tfstate.tf     # Terraform state 用 S3 bucket
│     ├─ outputs.tf
│     └─ terraform.tfvars.example
└─ modules/             # (再利用単位ができたら追加)
```

terraform は **直接叩かず常に `infra/tf.ps1` 経由**で実行する。この作業マシンの AWS CLI v2 は SSO セッション認証で、Terraform の AWS provider が credential chain を直接解決できないため、tf.ps1 が `aws configure export-credentials` で認証情報を環境変数に渡してから terraform を呼ぶ (詳細はスクリプト冒頭のコメント参照)。

## 管理対象

| カテゴリ | リソース | 定義ファイル |
|---|---|---|
| IAM | EC2 role + instance profile、SNS publish inline policy、`gs-worker-caller` user + policy | `iam.tf` |
| Network | Security Group + ingress/egress rule (default VPC / Subnet は `data` 参照) | `network.tf` |
| Compute | Launch Template `gs-game-server`、Key Pair (`data` 参照) | `compute.tf` |
| Storage | S3 bucket `gs-game-configs` (versioning + lifecycle + SSE-S3) | `storage.tf` |
| Notification | SNS topic `gs-alerts` + topic policy + Worker HTTPS subscription | `sns.tf` |
| Notification | 月次コスト Budget `gs-monthly-cap` ($20 上限、75% / 100% の 2 段) | `budgets.tf` |
| EventBridge | Spot 中断警告 rule (`EC2 Spot Instance Interruption Warning` → SNS) | `eventbridge.tf` |
| State | Terraform state 用 S3 bucket `gs-tfstate-prod-123456789012` | `tfstate.tf` |

## IaC 外 (意図的に手動)

- **IAM Access Key** (`gs-worker-caller`) — 値が state に入るため管理外。Phase 2 の OIDC 移行でキー方式ごと廃止予定
- **SSM SecureString** `/gs/atm11/rcon_password` — 秘密値を state に出さない
- **EBS snapshot 個別** — アプリ (Worker `/stop`) が生成。世代管理も Worker Cron (`handlers/snapshot-retention.ts`)
- **Cloudflare DNS record / zone / API Token** — DNS A レコードは Worker が `/start`・`/stop` で IP を実行時更新する (runtime 可変 = IaC 不適合)。IaC 化の要否は Phase 2 で再検討
- **Discord Application / Bot / Worker secrets** — 各公式 UI / Wrangler に閉じる

## state backend

S3 リモート backend (`gs-tfstate-prod-123456789012`、versioning + SSE-KMS)。state ロックは DynamoDB ではなく **S3 ネイティブロック** (`backend` の `use_lockfile`、Terraform 1.10+)。設定は `backend.tf`、state バケット自体の定義は `tfstate.tf`。

## 実行方法

### 前提

- Terraform 1.10+ (`winget install Hashicorp.Terraform`)
- AWS CLI v2 でログイン済 (tf.ps1 が認証をブリッジ)
- `envs/prod/terraform.tfvars` — `terraform.tfvars.example` をコピーして `worker_notification_url` を埋める (`terraform.tfvars` はコミットしない)

### 新しいマシンでの初期化

```powershell
.\infra\tf.ps1 init   # S3 backend に接続し provider を取得
```

### 通常の変更フロー

```powershell
.\infra\tf.ps1 plan -out=tfplan
# diff を確認 (spot price / instance type の変更は実費に直結する。必ず読む)
.\infra\tf.ps1 apply tfplan
```

## 出力 (`terraform output`)

`wrangler.toml` の `[vars]` にコピーする値を出力する:

```powershell
.\infra\tf.ps1 output
```

- `sns_alerts_topic_arn` → `SNS_ALLOWED_TOPIC_ARN`
- `security_group_id` / `default_subnet_id` / `launch_template_id` → `EC2_*`
- `s3_game_configs_bucket` / `key_pair_name` — 参照用

## smoke test

SNS → Worker → Discord の通知経路を確認する:

```powershell
aws sns publish `
  --topic-arn (.\infra\tf.ps1 output -raw sns_alerts_topic_arn) `
  --subject "IaC smoke test" `
  --message "Terraform-managed SNS topic working" `
  --region ap-northeast-1
```

→ Discord channel に緑 ℹ️ embed が届けば OK。届かないときの切り分け:

1. `pnpm wrangler tail` で Worker ログ — `SubscribeURL fetch failed` / `Discord webhook POST failed` が出ていないか
2. `aws sns list-subscriptions-by-topic --topic-arn <arn>` で `SubscriptionArn` が `PendingConfirmation` でなく実 ARN か
3. Worker の `DISCORD_WEBHOOK_URL` secret が入っているか (`pnpm wrangler secret list`)
