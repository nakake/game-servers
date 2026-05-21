# infra — AWS Terraform

AWS リソースを Terraform で宣言的に管理する。

design.md §10 の Phase 4 を先取りして, **手動でつまずいた箇所から段階的に** IaC 化していく方針。

## ディレクトリ

```
infra/
├─ envs/
│  └─ prod/             # 本番環境 (現状唯一)
│     ├─ versions.tf    # terraform / aws provider バージョン
│     ├─ providers.tf   # region + default_tags
│     ├─ backend.tf     # 当面 local state (Phase 4 で S3+DynamoDB 化)
│     ├─ variables.tf
│     ├─ sns.tf         # gs-alerts topic + policy + Worker HTTPS subscription
│     ├─ budgets.tf     # 月次コスト上限アラート
│     ├─ outputs.tf
│     └─ terraform.tfvars.example
└─ modules/             # (再利用単位ができたら追加)
```

## 現スコープ — Phase 1 補修: SNS 通知系のみ

Phase 1 で詰まった「Budget / SNS → Worker → Discord」通知経路の再構築。

含むもの:

- `aws_sns_topic.gs_alerts` ("gs-alerts")
- `aws_sns_topic_policy.gs_alerts` (Budgets / EventBridge service principal の publish 許可)
- `aws_sns_topic_subscription.worker_webhook` (HTTPS → Worker /aws/notification, auto-confirm)
- `aws_budgets_budget.monthly` ($20 上限, 75%/100% 2 段アラート)
- `aws_iam_role_policy.ec2_sns_publish` (EC2 instance role → SNS:Publish の inline policy)

**まだ IaC 外** (Phase 4 で順次):

- IAM (user / policy / role)
- VPC / Subnet / Security Group / Key Pair
- S3 bucket `gs-game-configs`
- EBS snapshot 系 + DLM
- EventBridge ルール (Spot 中断警告, DLM 失敗, CloudTrail 異常)

これらは手で作ったものが動作中なので, **触る必要が出たタイミングで個別に Terraform 化 + import** していく。

## bootstrap

### 1. Terraform をインストール (1.10+)

Windows:

```powershell
winget install Hashicorp.Terraform
# または scoop install terraform / choco install terraform
terraform version
```

### 2. AWS credentials

ローカル AWS CLI と同じ credential chain を使う (`%USERPROFILE%\.aws\credentials` の default profile)。手動 runbook で `aws ssm put-parameter` 等を叩けている credential で OK。

### 3. tfvars 用意

```powershell
cd F:\project\game_servers\infra\envs\prod
copy terraform.tfvars.example terraform.tfvars
# terraform.tfvars を編集して worker_notification_url を埋める
```

### 4. init + plan + apply

```powershell
terraform init
terraform plan -out=tfplan
# diff を確認 — 既存 SNS topic は CreateTopic 冪等性で「import せず取り込み」になる想定
terraform apply tfplan
```

### 5. 出力を控える

```powershell
terraform output sns_alerts_topic_arn
# arn:aws:sns:ap-northeast-1:<acct>:gs-alerts
```

この値が `wrangler.toml` の `SNS_ALLOWED_TOPIC_ARN` および EC2 role inline policy `gs-phase0-ec2-sns-publish` の Resource と一致していることを確認 (同一 ARN になるはずなので変更不要のことが多い)。

## 既存手動リソースとの cutover

`terraform apply` 後に AWS Console で以下を手で片付ける:

1. **古い HTTPS subscription** (Console で手作成したもの) を SNS → Subscriptions から削除。Terraform が作った新しい subscription だけ残す。
2. **古い Budget** を AWS Budgets から削除。Terraform 管理の `gs-monthly-cap` だけ残す。

ARN が同じトピックに 2 つ subscription がぶら下がると Discord に二重投稿される。budget の重複は支払い上は問題ないが分かりにくいので整理する。

## smoke test (cutover 後)

```powershell
aws sns publish `
  --topic-arn (terraform -chdir=F:\project\game_servers\infra\envs\prod output -raw sns_alerts_topic_arn) `
  --subject "IaC cutover smoke test" `
  --message "Terraform-managed SNS topic working" `
  --region ap-northeast-1
```

→ Discord channel に緑 ℹ️ embed が届けば OK。届かない場合の切り分け:

1. `pnpm wrangler tail` で Worker 側ログを見る — `SubscribeURL fetch failed` や `Discord webhook POST failed` が出ていないか
2. `aws sns list-subscriptions-by-topic --topic-arn <arn>` で `SubscriptionArn` が `PendingConfirmation` でなく実 ARN になっているか
3. Worker の `DISCORD_WEBHOOK_URL` secret が正しく入っているか (`pnpm wrangler secret list`)

## 今後の拡張順

全体ロードマップ・Step ごとの粒度・Open Questions は [docs/iac-migration-plan.md](../docs/iac-migration-plan.md) に集約。本 README は「`infra/` 配下に今あるものの説明」に絞る。
