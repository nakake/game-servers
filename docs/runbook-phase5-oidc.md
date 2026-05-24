# Runbook: Phase 5 OIDC

Phase 5 (OIDC 化 + IAM policy tightening) の運用手順集。計画書は [docs/phase5-plan.md](phase5-plan.md)。

各セクションは独立して使えるように書いてある (ある時点だけ切り取って再現できる)。

---

## 0. cutover 前の事前確認 — `Env=prod` tag backfill

Phase 5 Step 2.5.1 で導入する新 `gs-worker-oidc-policy` は **全 resource 系 statement に `aws:ResourceTag/Env = "prod"` 条件を付ける**。tag 未付与の resource が 1 件でも残っていると、Worker は `/start` / `/stop` / cron で即時 AccessDenied を踏む。Step 2.5.1 の `terraform apply` 前に必ず本セクションの (1)〜(3) を完了させること。

将来 staging Worker (Step 4) を作る際は同じ手順を `Env=staging` 版で実行する。

### (1) 欠落検出

3 つの resource type を AWS CLI で列挙し、`Env` tag が無いものを抽出する。**PowerShell ではバックティック (`` ` ``) がエスケープとして解釈されるため、JMESPath は `not_null(Tags[?Key=='Env'].Value | [0])` 形式で書く** (`Tags[?Key=` ` `Env` ` `]` 形式は壊れる)。

```powershell
# EC2 instance
aws ec2 describe-instances `
  --filters "Name=tag:Project,Values=game-servers" `
  --query "Reservations[].Instances[?!not_null(Tags[?Key=='Env'].Value | [0])].InstanceId" `
  --output text

# EBS volume
aws ec2 describe-volumes `
  --filters "Name=tag:Project,Values=game-servers" `
  --query "Volumes[?!not_null(Tags[?Key=='Env'].Value | [0])].VolumeId" `
  --output text

# EBS snapshot (AMI 由来の snapshot も含む)
aws ec2 describe-snapshots --owner-ids self `
  --filters "Name=tag:Project,Values=game-servers" `
  --query "Snapshots[?!not_null(Tags[?Key=='Env'].Value | [0])].SnapshotId" `
  --output text
```

3 つすべての出力が **空** であることがゴール。1 つでも ID が返ってきたら (2) に進む。

### (2) 欠落 resource に `Env=prod` を backfill

```powershell
aws ec2 create-tags --resources <ID1> <ID2> ... --tags Key=Env,Value=prod
```

複数 ID をスペース区切りで渡せる。`describe-instances` / `describe-volumes` / `describe-snapshots` の各出力 ID を分けずに 1 コマンドで投入して構わない (全 ec2 resource で `ec2:CreateTags` は同じ API)。

### (3) 再確認 + 将来の new resource 担保

(1) のコマンドを再実行し、3 つすべての出力が空になっていることを確認する。

加えて、将来 `/start` / `/stop` / Packer build で **新規生成される resource にも `Env=prod` が自動付与される** ことを以下 4 箇所で担保している (2026-05-24 時点で対応済):

| 経路 | 場所 | 何が付くか |
|---|---|---|
| `/start` で起動する EC2 instance | `infra/envs/prod/compute.tf` `aws_launch_template.game_server` の `tag_specifications` (instance) + `workers/discord-handler/src/handlers/discord/start.ts` `instanceTags` | LT と Worker の双方で `Env=prod` を冗長に指定 (RunInstances の TagSpecification は LT を上書きするため Worker 側必須) |
| `/start` で attach される EBS data volume | LT `tag_specifications` (volume) + start.ts `volumeTags` | 同上 |
| `/stop` で作成される EBS snapshot | `workers/discord-handler/src/handlers/stop-workflow.ts` `createSnapshot` の `tags` map | `Env=prod` 含む |
| Packer build で作成される AMI snapshot / 一時 builder EC2 / volume | `ami/game-server.pkr.hcl` の `snapshot_tags` / `run_tags` / `run_volume_tags` | AMI 本体 (`tags`) と分離して必ず明示する。次回 `pnpm build-sidecar-ami` から有効 |

これら 4 箇所のうち 1 箇所でも `Env` 指定が抜けると、新 resource が policy 条件から外れて Worker から見えなくなる。コード review 時の確認ポイントとして CLAUDE.md / phase5-plan に追記推奨。

### 過去対応履歴

- **2026-05-24**: Step 2.5.0 初回実施。既存 snapshot 4 件 (`snap-06e434398fafc82d6` / `snap-0ea1b9f2b2642acdd` / `snap-0dfd4494f5e2b88b3` / `snap-033f6fa6ea246eecb`) に `Env=prod` を backfill。EC2 / volume は当時ゼロ件のため backfill 不要。同日 Worker (`start.ts` `volumeTags` / `stop-workflow.ts` snapshot tags) と Packer (`game-server.pkr.hcl` `snapshot_tags` / `run_tags` / `run_volume_tags`) のコードにも `Env=prod` 自動付与を追加。
