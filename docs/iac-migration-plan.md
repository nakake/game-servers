# Terraform / IaC 移行計画

最終更新: 2026-05-22

## このドキュメントについて

Phase 1 で「手動コンソール作業 → silent fail (SNS publish の IAM 漏れ等)」が複数表面化したことを受け、design.md §10 Phase 4 を前倒しして **現状の手動 AWS リソースを段階的に Terraform に取り込む** ための計画。

各 Step は独立して `terraform apply` で完結し、Worker のコード変更が必要なものは明示する。Step 完了ごとに本ドキュメントの該当 checkbox を埋めて進捗を見える化する。

> **進捗 (2026-05-22)**: Step 0〜8 完了、Step 9 (Cloudflare) は IaC 不適合と判明し Phase 2 へ移管。**IaC 移行は完了** — 完了基準 4 項目すべて達成 (drift なし / S3 backend / runbook + infra/README 書き換え / 手動リソース棚卸し)。棚卸しで見つかった Phase 0 の孤児 LT `gs-phase0-lt` も削除済。

## 関連ドキュメント

- [docs/design.md](design.md) §10 Phase 4 — 全体ロードマップにおける IaC 化の位置付け
- [docs/runbook-phase1-production.md](runbook-phase1-production.md) — 手動で構築した内容 (= 取り込み対象の出典)
- [infra/README.md](../infra/README.md) — `infra/` の現状 (Step 0 まで反映)
- [CLAUDE.md](../CLAUDE.md) §Terraform — モジュール構造・命名・backend 方針

## 全体方針

1. **import 中心、再作成は最後の手段**。手動で動いているリソースは原則 `terraform import` で TF 管理下に取り込む (再作成すると依存リソースの ARN/ID が変わり Worker / wrangler.toml / 既存 EBS snapshot タグなどに波及する)。当初 SNS topic は「`CreateTopic` 冪等なので import せず apply で取り込める」と見込んでいたが、**Tags 付き `CreateTopic` を既存 topic かつタグ不一致で呼ぶと `InvalidParameter` (Topic already exists with different tags) の 400 になる**ため、topic も `import` が必要 (Step 0 で判明)。
2. **Worker のコード変更を最小化**。Step 1〜4 は import のみで Worker は不変。Step 5 (Launch Template 導入) で start.ts に、Step 6 (snapshot 世代管理) で Cron ハンドラに手を入れる。
3. **state は段階的に堅牢化**。Phase 1〜2 は local state、Step 8 で S3 backend (S3 ネイティブロック + SSE-KMS + versioning) に migrate。Access Key 値や SSM SecureString 値が state に入る間は `.gitignore` 済のローカル限定で扱う。
4. **IaC 不適合は明示**。Discord アプリ本体・Bot Token・Worker secrets は IaC で扱わず、それぞれの公式 UI / Wrangler に閉じる。

## 現状のリソース分類

| カテゴリ | リソース | 識別子 | 移行方法 |
|---|---|---|---|
| Network | VPC / Subnet (default) | `<YOUR_SUBNET_ID>` | `data` 参照 (import しない) |
| Network | Security Group | `sg-00cb1cc5269f27870` | `import` |
| Compute | Key Pair | `gs-phase0-key` | `data` 参照 (Step 4: import は public_key 不取得で再作成必至のため断念) |
| Compute | AMI (AL2023) | `resolve:ssm:/aws/service/...` | LT の `image_id` に `resolve:ssm:` リテラル (Step 5、起動毎 latest 解決) |
| Compute | Launch Template | `<YOUR_LAUNCH_TEMPLATE_ID>` | **新規済** (Step 5、案 B) |
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
| Lifecycle | snapshot 世代管理 | (Worker Cron) | **IaC 外** (Step 6、DLM は現アーキテクチャに不適合と判明し不採用) |
| EventBridge | Spot interruption rule | `gs-spot-interruption-warning` | **新規** (Step 7、完了) |
| EventBridge | DLM failure rule | — | **不採用** (Step 6 で DLM 不採用、監視対象なし) |
| Logs | CloudWatch Logs group (sidecar 用) | (未作成) | **Phase 3 持ち越し** (sidecar 未実装) |
| Cloudflare | Zone | (手動) | **Phase 2 へ移管** (Step 9 不採用) |
| Cloudflare | DNS record `atm11` | `<YOUR_CF_RECORD_ID>` | **IaC 外** (Worker が IP を実行時更新、Phase 2 で再検討) |
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

> Minecraft ポート (25565) は現状 `network.tf` にハードコード。`registry.json` 由来にする件は Step 5 着手時に見送り、ゲーム追加自動化を行う Phase 2 にまとめて持ち越した (ユーザー判断)。

Worker コード変更: なし。

### Step 3: Storage の import  *(完了 2026-05-21)*

- [x] `aws_s3_bucket.gs_game_configs` を import (`gs-game-configs`)
- [x] `aws_s3_bucket_public_access_block` / `aws_s3_bucket_server_side_encryption_configuration` を import (現状一致 — PAB は 4 項目すべて true、暗号化は SSE-S3 AES256)
- [x] `aws_s3_bucket_versioning` を新規宣言。**import 時点で versioning は無効だったが、ゲーム設定ファイルの誤上書き・誤削除への保険として Step 3 で有効化する判断 (ユーザー承認)**。apply で 無効→Enabled
- [x] `aws_s3_bucket_lifecycle_configuration` を新規。`launcher/` の noncurrent version を 30 日で expire (versioning ON で旧 tarball が残るため) + 全 prefix の incomplete multipart upload を 7 日で abort。`modpacks/` は expire ルールなし (永続)
- [x] SSM Parameter `/gs/atm11/rcon_password` は **案 b を採用** — import せず IaC 外。秘密値を state に出さない。生成手順は runbook-phase1-production.md §3.1 に既存
- [x] `terraform apply` (2 add / 1 change / 0 destroy — bucket は default tags、versioning + lifecycle が新規)、apply 後の `plan` は drift なし

Worker コード変更: なし。

### Step 4: Key Pair の取り込み  *(完了 2026-05-21)*

- [x] `aws_key_pair` の **import は断念**。import は `public_key` (Required・非 Computed 属性 = state 値は config 由来) を state に取り込めず、次の apply で鍵が ForceNew 再作成される (provider v5.100 の既知挙動、実機で確認)。代わりに `data "aws_key_pair" "gs_phase0"` で参照する — default VPC / Subnet と同じ「既存・再作成しない共有リソース」扱い (ユーザー承認)
- [x] data source 化につき apply 不要。`plan` は drift なし (No changes)
- [x] 秘密鍵 `.secrets/gs-phase0-key.pem` はそのまま `.gitignore` 配下で運用継続、IaC では扱わない
- [ ] (オプション) `tls_private_key` + `aws_key_pair` で新しい鍵を発行し旧 key と並行運用 → 旧 key 廃止。**Phase 2 に持ち越し** (未着手)。新規発行する鍵は create 由来なので `public_key` が正しく state に入り、その時点で TF 管理下の resource になる

Worker コード変更: なし。

### Step 5: Launch Template 新規導入 + Worker を LT 経由に切替  *(完了 2026-05-21)*

リスク分離のため 5a (Terraform、Worker 不変) → 5b (Worker 切替) の 2 段で実施した。

**Step 5a — Launch Template の新規作成**

- [x] `aws_launch_template.game_server` を新規宣言・apply (案 B、`<YOUR_LAUNCH_TEMPLATE_ID>`):
  - `image_id` = `resolve:ssm:.../al2023-ami-kernel-default-x86_64` の**リテラル文字列**を LT に直書き。`data "aws_ssm_parameter"` で apply 時点に固定する案は採らず、EC2 が起動毎に最新 AL2023 を解決する現状挙動を維持 (ユーザー判断)
  - `key_name` = Step 4 の `data.aws_key_pair.gs_phase0`
  - `vpc_security_group_ids` = Step 2 の SG
  - `iam_instance_profile.name` = Step 1 の instance profile
  - `block_device_mappings` (base): `/dev/sdf` の gp3 + `delete_on_termination=false`
  - `tag_specifications` (instance / volume): `Project=game-servers` / `Env=prod`、volume は加えて `Purpose=game-world`
  - `instance_market_options.market_type = "spot"` + `spot_options` (one-time / terminate)。**`max_price` は指定なし** = on-demand 価格を上限とする現状挙動を維持 (ユーザー判断)
  - `user_data` は **空** (Worker が override で渡す)
- [x] `outputs.tf` に `launch_template_id` を追加
- [x] `terraform apply` (1 add / 0 change / 0 destroy、apply 後の `plan` は drift なし)

**Step 5b — Worker を LT 経由に切替**

- [x] `ec2.ts` の `RunInstancesInput` に `launchTemplate` を追加、`imageId` / `securityGroupIds` を optional 化。`buildRunInstancesParams` が `LaunchTemplate.LaunchTemplateId` / `.Version` を emit
- [x] Worker `start.ts` の `runInstances` 呼び出しを LT 参照に書き換え。渡す引数は `LaunchTemplate { Id, Version: "$Latest" }` + `InstanceType` (registry の `instance_types[0]`) + `SubnetId` + `UserData` + `BlockDeviceMappings` + `TagSpecification`。`imageId` / `keyName` / `securityGroupIds` / `iamInstanceProfileName` / `spot` の直接指定は削除 (LT が供給)
- [x] **当初案からの変更点** (実装時に判明):
  - `instanceTags` / `volumeTags` は削除せず維持。`gs-worker-caller` の `ssm:SendCommand` が `aws:ResourceTag/Project` 条件付きで `/stop` が依存するため、instance の `Project` タグを LT/request のマージ挙動に賭けない。`Env` タグは `phase1`→`prod` に修正
  - `blockDeviceMappings` も削除せず `/dev/sdf` を全フィールド指定で維持。LT に同名 device があっても request 側 device 指定が優先されるため、`delete_on_termination=false` (world データ保護) を LT 任せにしない
  - `subnetId` も当初案の削除リストにあったが、LT に subnet を含めない方針 (`EC2_SUBNET_ID` 据え置き) と矛盾するため維持
- [x] `wrangler.toml` / `env.ts` / `.dev.vars.example` の vars から `EC2_IMAGE_ID` / `EC2_KEY_NAME` / `EC2_SECURITY_GROUP_ID` / `EC2_INSTANCE_PROFILE_NAME` を削除、`EC2_LAUNCH_TEMPLATE_ID` を追加 (Terraform output から取得)
- [x] `pnpm typecheck` / `wrangler deploy --dry-run` 通過 → `wrangler deploy` で本番反映
- [x] `/start atm11` → `/stop atm11` で実機検証。Spot 起動・snapshot 復元・instance/volume のタグ付与を確認。LT の `tag_specifications` と RunInstances の `TagSpecification` がマージされること (volume が Worker 非送出の `Env=prod` を持つ) も実機で確認

Worker コード変更: **あり** (`start.ts` + `ec2.ts` + `env.ts` + `wrangler.toml` + `.dev.vars.example`)。

### Step 6: snapshot 世代管理  *(完了 2026-05-21)*

**当初計画 (DLM) からの変更**: 本 Step と design.md §5.5 は当初「`/stop` で作った snapshot を
`aws_dlm_lifecycle_policy` が `target_tags={Purpose=game-world}` で拾って 3 世代に絞る」想定
だった。しかし **DLM の EBS スナップショット管理ポリシーは DLM 自身がスケジュール (interval /
cron) で作成した snapshot しか保持・削除しない**。Worker が `CreateSnapshot` で作る snapshot は
target_tags が一致しても DLM 管理対象外で、design §5.5 の `create_rule` を空にした「手動 trigger」
も DLM に存在しない機能 (`create_rule` は interval か cron が必須で、空では `terraform validate`
も通らない)。`EVENT_BASED_POLICY` 型もクロスアカウント snapshot 共有用で、自アカウントの
`CreateSnapshot` には反応しない。→ **DLM は不採用、世代管理は Worker の Cron で行う** (ユーザー判断)。

実装:

- [x] `ebs.ts` に `deleteSnapshot` を追加 (`DeleteSnapshot`、レスポンスは `<return>true</return>` でパース不要)
- [x] `handlers/snapshot-retention.ts` 新規。Cron tick ごとに registry の `allGames` を回し、Game ごとに
  `Game` + snapshot 専用マーカー `SnapshotType=game-world-data` で completed snapshot を取得、startTime
  降順で `registry.json` の `snapshot.generations` 本目より古い completed を `DeleteSnapshot`。pending
  (= `/stop` 直後の最新分) は次 tick へ繰り越し、error は手動対応に倒す
- [x] `index.ts` の `scheduled` に `handleSnapshotRetention` を追加 (既存 `handleVolumeCleanup` と並行、
  別 `waitUntil`)。Cron は既存の `*/5 * * * *` を流用し wrangler.toml の triggers は増やさない
- [x] `iam.tf` の `gs-worker-caller` policy `Ec2RunStopSnapshot` statement に `ec2:DeleteSnapshot` を追加
  (resources は既存の `*`)。`terraform plan` = 0 add / **1 change** / 0 destroy (policy document の差し替えのみ)
- [x] `pnpm typecheck` / `pnpm build` (wrangler dry-run) 通過

apply / deploy / 実機検証:

- [x] `infra/tf.ps1 apply tfplan` で IAM 変更を反映 (0 add / 1 change / 0 destroy)
- [x] `pnpm deploy` で Worker 本番反映 (IAM apply の後に実施)
- [x] `/start atm11` → `/stop atm11` を繰り返して検証。Cron tick で completed snapshot が
  4 本 → 3 本に収束 (最古 `snap-0a65…` を削除、最新 `snap-0c74…` は保持) することを実機確認。
  完成直後 (pending) の最新分は世代カウントに入れないため、収束は次 tick (最大 5 分) に遅延する

Worker コード変更: **あり** (`ebs.ts` + `handlers/snapshot-retention.ts` + `index.ts` + `wrangler.toml`)。

> 補足: Phase 0 で手動作成した seed snapshot (`<YOUR_SEED_SNAPSHOT_ID>`、wrangler.toml の
> `ATM11_SNAPSHOT_ID`) には snapshot 専用マーカー `SnapshotType=game-world-data` が付かない。
> マーカー必須フィルタにより世代管理の対象外となり、誤って自動削除されることはない。

### Step 7: EventBridge rule (Spot 中断警告) 新規  *(完了 2026-05-22)*

**当初計画 (3 rule + log group) からのスコープ縮小** (ユーザー判断 2026-05-22):

- `dlm_policy_failed` rule は **不採用**。Step 6 で DLM 自体を不採用 (snapshot 世代管理は Worker Cron) としたため、監視対象の DLM ポリシーが存在せず rule は空振りになる。Worker Cron の失敗は AWS イベントを出さず EventBridge では捕捉できないため、AWS ネイティブな代替も置かない。
- (任意) IAM 異常ログイン rule は **見送り**。CloudTrail (management events) が有効である必要があり、有効化状況が未確認のため本 Step のスコープ外。
- `aws_cloudwatch_log_group.sidecar` は **Phase 3 に持ち越し**。sidecar 実装が未着手で、log が来ない空の log group を先行作成しない。

実装 (`infra/envs/prod/eventbridge.tf` 新規):

- [x] `aws_cloudwatch_event_rule.spot_interruption` — default event bus の `EC2 Spot Instance Interruption Warning` (`source=aws.ec2`) を `event_pattern` で拾う
- [x] `aws_cloudwatch_event_target.spot_interruption_to_sns` — target は SNS `gs-alerts`。`input_transformer` で生イベント JSON を 1 行に整形 (instance-id / region / instance-action / time)。EventBridge → SNS は SNS Subject を設定できないため embed タイトルは Worker 側で "AWS notification" 固定になるが、本文に "interruption" を含むため Worker `inferSeverity` が critical 判定する
- [x] SNS topic policy は **変更不要** — `sns.tf` の `AllowAwsServicesPublish` が既に `events.amazonaws.com` の `SNS:Publish` を許可済
- [x] `terraform plan` = **2 add / 0 change / 0 destroy** (既存リソースに drift なし)
- [x] `infra/tf.ps1 apply tfplan` で反映 (2 added / 0 changed / 0 destroyed、apply 後の `plan` は `No changes` で drift なし)
- [x] テスト: Spot 中断シミュレーション。`aws ec2 send-spot-instance-interruption-warning` は存在しないため FIS の `aws:ec2:send-spot-instance-interruptions` action で代用 (`/start atm11` で稼働中の Spot instance を target にする FIS experiment template を作成・実行) → Discord に 🚨 critical embed が届くことを実機確認

Worker コード変更: なし。  
副次効果: design.md §4.6 の通知集約が完成する。

### Step 8: backend を S3 に migrate  *(完了 2026-05-22)*

**当初計画 (S3+DynamoDB) からの変更** (ユーザー判断 2026-05-22):

- ロックは `aws_dynamodb_table.tf_lock` を**作らず** S3 ネイティブロック (`backend` の `use_lockfile = true`) を採用。Terraform 1.10+ は `<key>.tflock` をバケット内に置いて排他でき、現環境は TF 1.15 で `dynamodb_table` 引数はむしろ非推奨。リソースを増やさずコスト 0 (決定1)。
- 暗号化は SSE-KMS の **AWS マネージドキー (`aws/s3`)** を採用。カスタマー管理 CMK ($1/月) は state バケットには過剰として見送り。`bucket_key_enabled` で KMS リクエスト料を抑制 (決定2)。

実装 (`infra/envs/prod/tfstate.tf` 新規 + `backend.tf` 書き換え):

- [x] `aws_s3_bucket.tf_state` (`gs-tfstate-prod-123456789012`) を新規・apply。`versioning` Enabled / `public_access_block` 4 項目 true / `server_side_encryption_configuration` SSE-KMS (`aws:kms` + `bucket_key_enabled`) / `lifecycle { prevent_destroy = true }`
- [x] ロックは S3 ネイティブ (`use_lockfile`)。DynamoDB テーブルは作らない
- [x] `infra/envs/prod/backend.tf` を `backend "local"` → `backend "s3"` に書き換え (`bucket` / `key = envs/prod/terraform.tfstate` / `region` / `encrypt` / `use_lockfile`)
- [x] `terraform init -migrate-state` で local → S3 移行 (state コピーに `yes`)。移行後の `terraform plan` = `No changes` で成功を確認
- [x] ローカルの `terraform.tfstate` / `.backup` / `init` が作った移行前スナップショットを削除 (`.gitignore` 済)
- [x] CLAUDE.md「Terraform」§の backend 記述を S3 ネイティブロックに更新

Worker コード変更: なし。

### Step 9: Cloudflare provider 導入  *(不採用 — Phase 2 へ移管 2026-05-22)*

**結論: 本 Step は実施せず、Cloudflare の IaC 化は Phase 2 に統合する** (ユーザー判断 2026-05-22)。

Step 9 で TF に取り込む唯一の候補だった DNS record が IaC 不適合と判明したため:

- `atm11` の DNS A レコードの `content` (IP) は **Worker が `/start` / `/stop` のたびに `cf.updateRecord()` で実行時に書き換える** (`workers/discord-handler/src/lib/cloudflare/dns.ts`、CLAUDE.md「Elastic IP 禁止 = 起動毎に DNS 更新」)。runtime で値が変わるリソースを TF 管理下に置くと毎 `apply` で drift が出て、IP を巻き戻し稼働中サーバーへの接続を壊しうる。EBS snapshot 個別 (Step 6) と同じ「アプリ生成・IaC 不適合」の構図。
- record の **作成**は `scripts/register-game.sh` (Phase 2 実装予定)、**更新**は Worker が担う設計。DNS のライフサイクルは Phase 2 のゲーム追加自動化そのものの設計事項であり、Cloudflare の IaC 化を論じるなら Phase 2 と一体で行うのが自然。
- record を管理しないなら `cloudflare` provider を入れても TF 側に管理対象が残らない (zone ID は Worker が env で保持)。
- 補足: Terraform は **provider 設定値 (API Token) を state に保存しない**。当初計画と「State の安全性」表の Token 前提はやや過剰だった (Step 8 の S3+SSE-KMS 化自体は無害で判断は妥当)。

→ 本 IaC 移行計画 (Step 0〜9) は **Step 8 をもって実質完了**とする。Cloudflare DNS の IaC 化要否は Phase 2 で `register-game.sh` の設計と合わせて判断する。

---

## 完了基準

- [x] `infra/envs/prod` の `terraform plan` が一切 drift を返さない (Step 8 完了時点で `No changes` を確認)
- [x] 「Terraform 管理外で手で作った」リソースが、Step 8 完了時点で **意図的に IaC 外と決めたもの**だけ — Discord アプリ / Bot 関連、Worker secrets、EBS snapshot 個別 (アプリ生成)、Cloudflare DNS record / zone / API Token (Step 9 移管、Phase 2 で再検討)、SSM SecureString param、IAM Access Key (Phase 2 OIDC で廃止予定)。2026-05-22 棚卸し実施 — `gs-` リソースは Terraform 管理集合と一致。唯一の例外だった Phase 0 の孤児 Launch Template `gs-phase0-lt` (`lt-0b769a03c54aec36d`、Step 5a の `gs-game-server` に置換済・参照元なし) は削除済
- [x] state が S3 backend、`.gitignore` 配下にローカル `tfstate` が残っていない (Step 8 で達成)
- [x] runbook-phase1-production.md の手動 AWS 構築手順 (Step 3.0〜3.5 等) が「Terraform で構築済」前提に書き換わっている (2026-05-22、`infra/README.md` も現状に更新)

## State の安全性

import に伴って **以下の機微情報が state に入る** ことに注意:

| リソース | state に入る値 | 対処 |
|---|---|---|
| `aws_iam_access_key` | secret access key | IaC 管理外 (Step 1 で決定)。Phase 2 OIDC でキー方式ごと廃止 |
| `aws_ssm_parameter` (SecureString) | パラメータ値 | import せず IaC 外 (Step 3) |
| `aws_key_pair` | public key のみ (secret は AWS 側にも存在しない) | OK |
| Cloudflare API Token | (該当なし) | Step 9 を Phase 2 へ移管し TF は Cloudflare を扱わない。そもそも provider 設定値は state に保存されない |

local state 期間 (Step 0〜7) は `.gitignore` 配下のローカル限定。Step 8 で S3+SSE-KMS backend に移してから、上記のうち IaC 内に置く判断をしたものは「state 暗号化前提で OK」扱いに切り替える。

## IaC 化しないもの (恒久的に手動)

- **Discord Application / Bot / Public Key** — Discord 側に Terraform provider が無い (community provider はあるが本番投入は時期尚早)
- **Discord Bot Token** — Wrangler secret 経由
- **Cloudflare API Token** — CF UI でしか発行できない
- **Cloudflare DNS record / zone** — `atm11` 等の A レコードは Worker が `/start`/`/stop` で IP を実行時更新する (runtime 可変 = IaC 不適合、EBS snapshot 個別と同じ扱い)。record 作成は Phase 2 の `register-game.sh`。Cloudflare の IaC 化方針は Phase 2 で再検討 (Step 9 を移管)
- **Worker secrets** — `wrangler secret put` が公式の流儀
- **EBS snapshot の世代** — アプリ動作 (Worker `/stop`) で生成。世代管理も Worker の Cron (`handlers/snapshot-retention.ts`) で行う (Step 6、DLM 不採用)。個々の snapshot は TF で宣言しない
- **wrangler.toml の vars** — Worker デプロイで管理 (ただし Terraform output の値をコピーする運用)

## Open Questions

- [ ] **Step 5 後の Worker → AWS 認証**: Phase 2 で OIDC (Cloudflare Workers → AWS AssumeRole) に切り替える計画 (design.md §5.6)。Step 1 で取り込む Access Key の rotation を、OIDC 移行までの繋ぎ運用にするか、すぐ OIDC にするか
- [x] **EBS snapshot tag の整合** (Step 6 で解決): DLM 不採用となり、Worker 側世代管理は `/stop` が付ける snapshot 専用マーカー `SnapshotType=game-world-data` でフィルタする。このマーカーは Worker の `CreateSnapshot` でのみ付与され volume / root volume には付かないため、Phase 0 の手動 snapshot や root クローンを誤って世代管理対象に巻き込まない
- [x] **Step 9 と Phase 2 の重複** (解決 2026-05-22 — Step 9 を Phase 2 へ移管): `atm11` の DNS A レコードは Worker が `/start`/`/stop` で IP を実行時更新するため IaC 不適合と判明。Cloudflare DNS の IaC 化は Phase 2 の `register-game.sh` 設計と一体で再検討する。詳細は Step 9 セクション参照
- [ ] **default VPC 依存**: 現状 default VPC + default subnet を使用。将来 (Phase 5 以降) で専用 VPC を作るなら、Step 2 の `data` 参照を `resource` 宣言に置き換える Phase が増える
