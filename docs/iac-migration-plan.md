# Terraform / IaC 移行計画

最終更新: 2026-05-21

## このドキュメントについて

Phase 1 で「手動コンソール作業 → silent fail (SNS publish の IAM 漏れ等)」が複数表面化したことを受け、design.md §10 Phase 4 を前倒しして **現状の手動 AWS リソースを段階的に Terraform に取り込む** ための計画。

各 Step は独立して `terraform apply` で完結し、Worker のコード変更が必要なものは明示する。Step 完了ごとに本ドキュメントの該当 checkbox を埋めて進捗を見える化する。

## 関連ドキュメント

- [docs/design.md](design.md) §10 Phase 4 — 全体ロードマップにおける IaC 化の位置付け
- [docs/runbook-phase1-production.md](runbook-phase1-production.md) — 手動で構築した内容 (= 取り込み対象の出典)
- [infra/README.md](../infra/README.md) — `infra/` の現状 (Step 0 まで反映)
- [CLAUDE.md](../CLAUDE.md) §Terraform — モジュール構造・命名・backend 方針

## 全体方針

1. **import 中心、再作成は最後の手段**。手動で動いているリソースは原則 `terraform import` で TF 管理下に取り込む (再作成すると依存リソースの ARN/ID が変わり Worker / wrangler.toml / 既存 EBS snapshot タグなどに波及する)。当初 SNS topic は「`CreateTopic` 冪等なので import せず apply で取り込める」と見込んでいたが、**Tags 付き `CreateTopic` を既存 topic かつタグ不一致で呼ぶと `InvalidParameter` (Topic already exists with different tags) の 400 になる**ため、topic も `import` が必要 (Step 0 で判明)。
2. **Worker のコード変更を最小化**。Step 1〜4 は import のみで Worker は不変。Step 5 (Launch Template 導入) で初めて start.ts に手を入れる。
3. **state は段階的に堅牢化**。Phase 1〜2 は local state、Phase 4 末で S3+DynamoDB (SSE-KMS + versioning) backend に migrate。Access Key 値や SSM SecureString 値が state に入る間は `.gitignore` 済のローカル限定で扱う。
4. **IaC 不適合は明示**。Discord アプリ本体・Bot Token・Worker secrets は IaC で扱わず、それぞれの公式 UI / Wrangler に閉じる。

## 現状のリソース分類

| カテゴリ | リソース | 識別子 | 移行方法 |
|---|---|---|---|
| Network | VPC / Subnet (default) | `<YOUR_SUBNET_ID>` | `data` 参照 (import しない) |
| Network | Security Group | `sg-00cb1cc5269f27870` | `import` |
| Compute | Key Pair | `gs-phase0-key` | `import` (public key のみ、秘密鍵は `.secrets/`) |
| Compute | AMI (AL2023) | `resolve:ssm:/aws/service/...` | `data "aws_ssm_parameter"` で参照 |
| Compute | Launch Template | (未作成) | **新規** (Step 5、案 B) |
| Compute | EBS snapshot (seed) | `<YOUR_SEED_SNAPSHOT_ID>` | `data` 参照 (運用で生成されるため import せず) |
| IAM | Role + Instance Profile | `gs-phase0-ec2-role` | `import` |
| IAM | Role の AWS マネージドポリシー attach | SSM core / S3 read-only | `import` (inline policy ではなく attach だった) |
| IAM | Role inline policy (SNS publish) | `gs-phase0-ec2-sns-publish` | **既に着手済** (Step 0) |
| IAM | User | `gs-worker-caller` | `import` (Access Key は IaC 管理外、Phase 2 OIDC で廃止) |
| IAM | User policy | `gs-worker-caller-policy` | `import` |
| Storage | S3 bucket | `gs-game-configs` | `import` (versioning, lifecycle 同時) |
| Storage | SSM Param (SecureString) | `/gs/atm11/rcon_password` | IaC 外 (案 b、Step 3 で確定。値を state に出さない) |
| Notification | SNS topic | `gs-alerts` | `import` (Step 0、Tags 不一致で apply 自動取り込み不可と判明) |
| Notification | SNS topic policy | (現状空 or AWS 自動付与) | **着手済** |
| Notification | SNS HTTPS subscription | (手動) | **着手済** (旧 subscription は apply 後に手で削除) |
| Notification | AWS Budget | (手動) | **着手済** (新名 `gs-monthly-cap` で並行作成 → 旧削除) |
| Lifecycle | DLM policy | (未作成) | **新規** (Step 6) |
| EventBridge | Spot interruption rule | (未作成) | **新規** (Step 7) |
| EventBridge | DLM failure rule | (未作成) | **新規** (Step 7) |
| Logs | CloudWatch Logs group (sidecar 用) | (未作成) | **新規** (Step 7 or 別建て) |
| Cloudflare | Zone | (手動) | **`cloudflare` provider** で `data` 参照 |
| Cloudflare | DNS record `atm11` | `<YOUR_CF_RECORD_ID>` | `import` |
| Cloudflare | API Token | (手動 UI) | ❌ IaC 不適合 |
| Discord | Application / Bot / Public Key | (手動 UI) | ❌ IaC 不適合 |
| Discord | Slash command | (scripts/register-discord-commands.mjs) | コード化済 (IaC 対象外) |
| Worker | Secrets | (wrangler secret put) | ❌ IaC 不適合 (Wrangler 公式の流儀) |
| Worker | vars (wrangler.toml) | (現状リポジトリ) | Worker デプロイで管理 (IaC 対象外、ただし TF output を参照する) |

## Launch Template の方針 — 案 B を採用

現状 Worker は `RunInstances` API を直接叩き、AMI / instance type / key / SG / IAM profile / user-data / spot 設定 / block device / tag を全部引数で渡している。LT に置き換える案は 3 つ:

| 案 | LT のスコープ | Worker 側 | ゲーム追加コスト |
|---|---|---|---|
| A. 現状維持 | LT 不使用 | 不変 | 軽 |
| **B. 薄い LT** | **AMI / Key / SG / IAM profile / EBS base / tag spec / spot 設定**を入れる。user-data と snapshot ID は override | LT ID 指定 + 2 項目 override | 軽 |
| C. 厚い LT | game ごとに LT 別に持つ (user-data も焼く) | LT ID だけ | 重 (LT 増殖) |

**採用: B**。理由:
- spot price / tag spec / IAM profile を IaC 一元管理できる
- CLAUDE.md「ゲーム別ロジックを Worker に散らさない」「registry 駆動を死守」と整合 (LT 自体に game_id を入れない)
- design.md §3.2「ゲーム追加は登録ファイル 1 個 + DNS レコード 1 個で完結」と整合
- Worker の `runInstances` 呼び出し引数を 8 → 3 (LT ID + user-data override + block device snapshotId override) に削減できる

C は「ゲーム追加で LT 追加」になり登録駆動と矛盾するため不採用。

---

## 移行ステップ

### Step 0: SNS / Budget / EC2 inline policy を apply  *(完了 2026-05-21)*

- [x] `winget install Hashicorp.Terraform` (v1.15.4)
- [x] `infra/envs/prod/terraform.tfvars` 作成、`worker_notification_url` を埋める
- [x] `terraform init` (hashicorp/aws v5.100.0、lock file は commit 済)
- [x] `terraform import aws_sns_topic.gs_alerts arn:aws:sns:ap-northeast-1:<account>:gs-alerts` — 既存の手動 topic を取り込む (Tags 不一致で apply 自動取り込み不可のため)
- [x] `terraform plan -out=tfplan` (4 add / 1 change / 0 destroy)
- [x] `terraform apply tfplan` (4 added / 1 changed / 0 destroyed、apply 後の `plan` は drift なし)
- [x] 旧手動 HTTPS subscription の削除 → **不要だった**。同一エンドポイントを SNS が重複排除し、Terraform が既存の confirmed subscription を取り込んだ (gs-alerts の subscription は 1 本のみ)
- [x] 旧手動 Budget を Budgets Console で削除 (`gs-monthly-cap` のみ残)
- [x] `aws sns publish` smoke test → Discord 到達確認 (緑 ℹ️ embed 受信)
- [ ] (任意) `/start atm11` → user-data の `aws sns publish` が `AuthorizationError` を出さず Discord に「✅ 接続可能になりました」が届くこと。EC2 role 経由の publish 自体は Phase 1 で実証済のため再確認は任意

> 補足 (Step 0 で判明した運用メモ): ローカル AWS CLI v2 がカスタム "login" 方式 (SSO セッション) で認証しているため、Terraform の AWS provider が credential chain を直接解決できない。`aws configure export-credentials` で解決済の認証情報を環境変数に渡してから terraform を実行する。

**着手済の HCL**: `aws_sns_topic.gs_alerts`, `aws_sns_topic_policy.gs_alerts`, `aws_sns_topic_subscription.worker_webhook`, `aws_budgets_budget.monthly`, `aws_iam_role_policy.ec2_sns_publish`

Worker コード変更: なし。

### Step 1: IAM の import  *(完了 2026-05-21)*

- [x] `aws_iam_role.gs_phase0_ec2` を import
- [x] `aws_iam_instance_profile.gs_phase0_ec2` を import
- [x] role の SSM/S3 権限は **inline policy ではなく AWS マネージドポリシーの attach** だった (`AmazonSSMManagedInstanceCore` / `AmazonS3ReadOnlyAccess`)。`aws_iam_role_policy_attachment` ×2 として import
- [x] Step 0 で書いた `aws_iam_role_policy.ec2_sns_publish` の `role` 属性を文字列リテラルから `aws_iam_role.gs_phase0_ec2.name` 参照に書き換え
- [x] `aws_iam_user.gs_worker_caller` を import
- [x] user ポリシーは **inline ではなくカスタマー管理ポリシーの attach** だった。`aws_iam_policy.gs_worker_caller` (= `gs-worker-caller-policy`) + `aws_iam_user_policy_attachment` として import
- [x] **Access Key** は IaC 管理外で確定 (ユーザー判断)。既存キー `AKIA...JCUVJ74` をそのまま運用し、Phase 2 の OIDC 移行でキー方式ごと廃止する (rotation は行わない)
- [x] `terraform apply` (0 add / 4 change / 0 destroy — 全て default tags 付与)、apply 後の `plan` は drift なし

Worker コード変更: なし。Worker secrets 変更: なし (Access Key rotation を見送ったため)。

### Step 2: Network の import  *(完了 2026-05-21)*

- [x] `data "aws_vpc" "default"` で default VPC を参照 (`vpc-0b9c1a51710d5d5ce`、import せず data 参照)
- [x] `data "aws_subnet" "default_a"` で default subnet を参照 (`<YOUR_SUBNET_ID>`、ap-northeast-1a)
- [x] `aws_security_group.game_server` を import (`sg-00cb1cc5269f27870` = `gs-phase0-sg`)
- [x] SG の ingress / egress を個別 rule リソースに分解。**当初案の `aws_security_group_rule` ではなく provider v5 系の新リソース `aws_vpc_security_group_ingress_rule` / `_egress_rule` を採用** (rule 単位の description `Admin SSH` / `Minecraft` と tag を保持でき、HashiCorp が新規はこちらを推奨)。ingress 2 本 (`ssh_admin` `sgr-0a8c…`, `minecraft` `sgr-05ad…`) + egress 1 本 (`all` `sgr-0d28…`) を import
- [x] SSH 許可元 IP を `var.admin_ssh_cidr` (default `126.94.68.118/32`) に切り出し、ISP 変更時に HCL を書き換えやすくした
- [x] `terraform apply` (0 add / 4 change / 0 destroy — 全て default tags 付与)、apply 後の `plan` は drift なし

> Minecraft ポート (25565) は現状 `network.tf` にハードコード。`registry.json` 由来にする件は Step 5 の Launch Template 整理とあわせて対応する。

Worker コード変更: なし。

### Step 3: Storage の import  *(完了 2026-05-21)*

- [x] `aws_s3_bucket.gs_game_configs` を import (`gs-game-configs`)
- [x] `aws_s3_bucket_public_access_block` / `aws_s3_bucket_server_side_encryption_configuration` を import (現状一致 — PAB は 4 項目すべて true、暗号化は SSE-S3 AES256)
- [x] `aws_s3_bucket_versioning` を新規宣言。**import 時点で versioning は無効だったが、ゲーム設定ファイルの誤上書き・誤削除への保険として Step 3 で有効化する判断 (ユーザー承認)**。apply で 無効→Enabled
- [x] `aws_s3_bucket_lifecycle_configuration` を新規。`launcher/` の noncurrent version を 30 日で expire (versioning ON で旧 tarball が残るため) + 全 prefix の incomplete multipart upload を 7 日で abort。`modpacks/` は expire ルールなし (永続)
- [x] SSM Parameter `/gs/atm11/rcon_password` は **案 b を採用** — import せず IaC 外。秘密値を state に出さない。生成手順は runbook-phase1-production.md §3.1 に既存
- [x] `terraform apply` (2 add / 1 change / 0 destroy — bucket は default tags、versioning + lifecycle が新規)、apply 後の `plan` は drift なし

Worker コード変更: なし。

### Step 4: Key Pair の取り込み

- [ ] `aws_key_pair.gs_phase0` を import (public key だけ TF 管理)
- [ ] 秘密鍵 `.secrets/gs-phase0-key.pem` はそのまま `.gitignore` 配下で運用継続
- [ ] (オプション) `tls_private_key` + `aws_key_pair` で新しい鍵を発行し旧 key と並行運用 → 旧 key 廃止、まで Phase 2 でやってもよい

Worker コード変更: なし。

### Step 5: Launch Template 新規導入 + Worker を LT 経由に切替

- [ ] `aws_launch_template.game_server` を新規宣言 (案 B):
  - `image_id` = AL2023 (data 参照)
  - `key_name` = Step 4 の key
  - `vpc_security_group_ids` = Step 2 の SG
  - `iam_instance_profile.name` = Step 1 の instance profile
  - `block_device_mappings` (base): `/dev/sdf` の gp3 設定のみ (snapshotId は override)
  - `tag_specifications` (instance / volume): `Project=game-servers` 等
  - `instance_market_options.market_type = "spot"` + `spot_options`
  - `user_data` は **空** (Worker が override で渡す)
- [ ] Worker `start.ts` の `runInstances` 呼び出しを LT 参照に書き換え:
  - 渡す引数: `LaunchTemplate { Id, Version: "$Latest" }`, `UserData` (base64), `BlockDeviceMappings` (snapshotId override のみ), `InstanceType` (registry の `instance_types[0]`)
  - 既存の `imageId` / `keyName` / `securityGroupIds` / `subnetId` / `iamInstanceProfileName` / `volumeTags` / `instanceTags` の直接指定を削除
- [ ] wrangler.toml の vars から不要になった `EC2_IMAGE_ID` / `EC2_KEY_NAME` / `EC2_SECURITY_GROUP_ID` / `EC2_INSTANCE_PROFILE_NAME` を削除し、代わりに `EC2_LAUNCH_TEMPLATE_ID` を追加 (Terraform output から取得)
- [ ] `/start atm11` で実機検証 → snapshot から復元できること、tag が正しく付くこと

Worker コード変更: **あり** (start.ts + env.ts + wrangler.toml)。  
リスクが集中する Step なので Step 0〜4 を全部 apply してから着手する。

### Step 6: DLM policy 新規

- [ ] `aws_iam_role.dlm_lifecycle` 新規 (DLM service が assume する)
- [ ] `aws_dlm_lifecycle_policy.game_world` 新規 (design.md §5.5):
  - target_tags = `{ Purpose = "game-world" }`
  - schedule: `every-stop-3gen` (event-based)
  - retain_rule.count = 3
- [ ] Worker の `/stop` フローで作成されている snapshot に `Purpose=game-world` タグが付いていることを確認 (現状の `volumeTags` に既にあるはず)
- [ ] 1 度 `/start` → `/stop` を実行し、DLM 配下に snapshot が紐付くこと確認

Worker コード変更: なし。

### Step 7: EventBridge rules + CloudWatch Logs 新規

- [ ] `aws_cloudwatch_event_rule.spot_interruption` — Spot 中断警告 (`EC2 Spot Instance Interruption Warning`) → SNS `gs-alerts`
- [ ] `aws_cloudwatch_event_rule.dlm_policy_failed` — DLM Policy State Change の `ERROR` → SNS `gs-alerts`
- [ ] (任意) `aws_cloudwatch_event_rule.iam_unusual_login` — CloudTrail `ConsoleLogin` の異常パターン → SNS `gs-alerts`
- [ ] `aws_cloudwatch_log_group.sidecar` (Phase 3 sidecar 用、retention 7 日)
- [ ] テスト: Spot 中断シミュレーション (`aws ec2 send-spot-instance-interruption-warning` は無いので, FIS の `aws:ec2:send-spot-instance-interruptions` action で代用) → Discord 到達確認

Worker コード変更: なし。  
副次効果: design.md §4.6 の通知集約が完成する。

### Step 8: backend を S3+DynamoDB に migrate

- [ ] `aws_s3_bucket.tf_state` 新規 (versioning + SSE-KMS、public access block)
- [ ] `aws_dynamodb_table.tf_lock` 新規 (LockID PK)
- [ ] `infra/envs/prod/backend.tf` を `backend "s3"` に書き換え
- [ ] `terraform init -migrate-state` で local → S3 移行
- [ ] ローカルの `terraform.tfstate*` ファイルを削除 (`.gitignore` 済だが念のため)

CLAUDE.md「Terraform」§にある通り `prod` 環境を S3+DynamoDB で堅牢化。Phase 4 着手時の最終仕上げ。

Worker コード変更: なし。

### Step 9: Cloudflare provider 導入

- [ ] `cloudflare` provider を `infra/envs/prod/providers.tf` に追加
- [ ] `data "cloudflare_zone"` で zone 参照
- [ ] `aws_route53_record` ではなく `cloudflare_record.atm11` を import (`<YOUR_CF_RECORD_ID>`)
- [ ] API Token は Terraform 内で発行できない (CF UI 限定) ので `var.cloudflare_api_token` を `terraform.tfvars` 経由で渡す
- [ ] Phase 2 (ゲーム追加自動化) で `scripts/register-game.sh` が DNS record を作る役割と重複しないよう調整 (Phase 2 で再設計)

Worker コード変更: なし。

---

## 完了基準

- [ ] `infra/envs/prod` の `terraform plan` が一切 drift を返さない (= AWS 側状態と HCL が一致)
- [ ] AWS Console で「Terraform 管理外で手で作った」リソースが、Step 9 完了時点で **Discord アプリ / Bot 関連 / Worker secrets / EBS snapshot 個別 (アプリ生成)** だけになっている
- [ ] state が S3 backend、`.gitignore` 配下にローカル `tfstate` が残っていない
- [ ] runbook-phase1-production.md の手動 AWS 構築手順 (Step 3.0〜3.5 等) が「Terraform で構築済」前提に書き換わっている

## State の安全性

import に伴って **以下の機微情報が state に入る** ことに注意:

| リソース | state に入る値 | 対処 |
|---|---|---|
| `aws_iam_access_key` | secret access key | IaC 管理外 (Step 1 で決定)。Phase 2 OIDC でキー方式ごと廃止 |
| `aws_ssm_parameter` (SecureString) | パラメータ値 | import せず IaC 外 (Step 3) |
| `aws_key_pair` | public key のみ (secret は AWS 側にも存在しない) | OK |
| Cloudflare API Token | `var` で渡す値 | tfvars (gitignore) + state は S3+SSE-KMS で保護 |

local state 期間 (Step 0〜7) は `.gitignore` 配下のローカル限定。Step 8 で S3+SSE-KMS backend に移してから、上記のうち IaC 内に置く判断をしたものは「state 暗号化前提で OK」扱いに切り替える。

## IaC 化しないもの (恒久的に手動)

- **Discord Application / Bot / Public Key** — Discord 側に Terraform provider が無い (community provider はあるが本番投入は時期尚早)
- **Discord Bot Token** — Wrangler secret 経由
- **Cloudflare API Token** — CF UI でしか発行できない (Token 自体は ↑ で tfvars 経由)
- **Worker secrets** — `wrangler secret put` が公式の流儀
- **EBS snapshot の世代** — アプリ動作 (Worker `/stop`) で生成。世代管理は DLM (IaC) だが個々の snapshot を TF で宣言しない
- **wrangler.toml の vars** — Worker デプロイで管理 (ただし Terraform output の値をコピーする運用)

## Open Questions

- [ ] **Step 5 後の Worker → AWS 認証**: Phase 2 で OIDC (Cloudflare Workers → AWS AssumeRole) に切り替える計画 (design.md §5.6)。Step 1 で取り込む Access Key の rotation を、OIDC 移行までの繋ぎ運用にするか、すぐ OIDC にするか
- [ ] **EBS snapshot tag の整合**: Step 6 で DLM の `target_tags = {Purpose = "game-world"}` を入れるが、現状の手動 snapshot にこのタグが付いていない可能性。Step 6 着手時に既存 snapshot の tag を一括補正するか、新規分のみ DLM 対象とするか
- [ ] **Step 9 と Phase 2 の重複**: Cloudflare DNS record の管理を Terraform に寄せると、Phase 2 の「ゲーム追加 = registry 更新 + DNS 自動生成」のフローと役割衝突する。Worker から DNS API を叩く現方針を維持するなら DNS record は IaC 管理外にする選択もあり
- [ ] **default VPC 依存**: 現状 default VPC + default subnet を使用。将来 (Phase 5 以降) で専用 VPC を作るなら、Step 2 の `data` 参照を `resource` 宣言に置き換える Phase が増える
