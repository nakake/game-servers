# Runbook — Phase 4 通知拡張の実機検証

最終更新: 2026-05-24

## このドキュメントについて

`docs/phase4-plan.md` **Step 5** の実機検証手順。Phase 4 で Discord channel に出るように
した 3 系統の通知 (A. idle 停止 / B. Spot 中断警告 / C. snapshot 削除失敗) を、本番環境で
1 つずつ発火させて Discord channel に届くことを確認する。

実行はユーザーが手元の PowerShell から行う。本書はコマンド + 期待結果 + トラブルシュート
観点をまとめる。

参照:
- [docs/phase4-plan.md](phase4-plan.md) 全体計画 / 完了基準
- [docs/runbook-phase3-sidecar.md](runbook-phase3-sidecar.md) §6 (Phase 3 の実機検証手順、A の前提)
- [infra/envs/prod/eventbridge.tf](../infra/envs/prod/eventbridge.tf) — Spot 中断 → SNS 配線
- [workers/discord-handler/src/handlers/aws-notification.ts](../workers/discord-handler/src/handlers/aws-notification.ts) — 整形ロジック

## 前提

- Phase 3 まで完了 (`/start atm11` で ATM11 が立ち、`/stop` も動く状態)
- `DISCORD_WEBHOOK_URL` が Worker secret に投入済 (Phase 1 で投入済)
- `SNS_ALLOWED_TOPIC_ARN` が `gs-alerts` の ARN になっている
- EventBridge rule `gs-spot-interruption-warning` が `terraform apply` 済 (IaC migration Step 7)
- 作業マシン: Windows + PowerShell 7+、AWS CLI v2、Wrangler 3.x

## A. idle 停止通知 (sidecar 経路)

`docs/phase3-plan.md` §6.4 の手順と同じ流れだが、**Phase 4 の差分は「Discord channel に
📴 embed が投稿される」こと**。

### 手順

1. Discord で `/start atm11` を叩く。`✅ ATM11: サーバーの起動が完了しました` が出るまで待つ
   (初回 mod ロードで 10 分前後かかる)
2. クライアントから ATM11 にログイン → 数秒後に切断 (sidecar は `PAUSE_WHEN_EMPTY_SECONDS=60`
   後から idle 判定を始める)
3. 約 `timeout_min` (10 分) + 数分の skew 待ち。sidecar が idle 検知 → Worker `/sidecar/idle-detected`
   → `runStopWorkflow` が走る
4. **Discord channel** (DISCORD_WEBHOOK_URL の宛先) に次の embed が出ることを確認:
   - title: `📴 All The Mods 11 を自動停止しました`
   - color: 青 (`0x3498db`)
   - description: `経路: sidecar (idle 検知)` + `snapshot: snap-xxx (次回 /start で使用)` +
     `旧 volume vol-xxx は snapshot 完成後に自動削除されます`
   - footer: `instance: i-xxx`

### 失敗時の切り分け

| 症状 | 確認 |
|---|---|
| stop 自体は走るが Discord に何も出ない | `wrangler tail` で `idle-stop notification post threw` を grep。`DISCORD_WEBHOOK_URL` 未設定の可能性 |
| stop 自体が走らない | Phase 3 の問題。`runbook-phase3-sidecar.md` §トラブルシュートに戻る |
| embed が出るが色 / 文面がおかしい | `workers/discord-handler/src/lib/discord/notifications.ts` の `buildIdleStopNotification` を確認、unit test (`notifications.test.ts`) も実行 |

### Cron フォールバック経路の確認 (任意)

sidecar を意図的に止めて Cron フォールバックを発火させるのは難しい (sidecar が落ちるケースは
本番では稀)。本 Step では unit test (`idle-fallback.test.ts`) と `buildIdleStopNotification`
test (`notifications.test.ts` の `cron-fallback` ケース) で担保し、実機検証は sidecar 経路のみ。

## B. Spot 中断警告通知

### 手順

ATM11 を起動中の状態で、AWS Fault Injection または `send-spot-instance-interruption` で
EventBridge イベントを擬似発火する。

```powershell
# 起動中の atm11 instance を取得
$instanceId = aws ec2 describe-instances `
  --filters "Name=tag:Game,Values=atm11" "Name=instance-state-name,Values=running" `
  --query 'Reservations[0].Instances[0].InstanceId' `
  --output text `
  --region ap-northeast-1

# Spot interruption を擬似発火
aws ec2 send-spot-instance-interruption `
  --instance-id $instanceId `
  --region ap-northeast-1
```

> **注**: `send-spot-instance-interruption` API は **実際に 2 分後に terminate される**。
> 検証目的なら起動直後に発火させ、Discord 通知の確認だけ済んだら手動 `/stop` で正常停止
> 経路を回す (検証中の世界データはほぼ進んでいないので snapshot 上書きでも実害なし)。

### 期待される Discord embed

- title: `🚨 Spot 中断警告 (約 2 分で EC2 回収)`
- color: 赤 (`0xdc2626`)
- description 先頭:
  ```
  ⚠️ 約 2 分以内に EC2 が Spot reclaim されます。
  セーブを優先したい場合は今すぐ手動 /stop を叩いてください
  (本フェーズでは自動 graceful stop は走りません)。

  ---
  Spot interruption warning: instance i-xxx (ap-northeast-1); action=terminate; reclaimed in ~2 min; event time 2026-05-24T...
  ```

### 失敗時の切り分け

| 症状 | 確認 |
|---|---|
| Discord に何も来ない | (1) `aws events list-rules --name-prefix gs-spot` で rule 存在を確認 (2) `aws sns list-subscriptions-by-topic` で Worker endpoint subscription が `Confirmed` になっているか (3) `wrangler tail` で `/aws/notification` が叩かれているか |
| `🚨 AWS notification` という generic title で出る | `isSpotInterruptionMessage` の prefix 検出が外れた。`infra/envs/prod/eventbridge.tf` の `input_template` が `"Spot interruption warning:"` で始まっているか確認 |
| description は出るが embed color が違う | `inferSeverity` の判定が外れた → 文面に `interruption` 含まれているか確認 |

## C. snapshot 削除失敗通知 (Step 4 で追加予定)

Step 4 (snapshot 削除失敗通知) は **実機での意図的な失敗発火が難しい** (DeleteSnapshot は
権限と存在さえあれば成功するため)。代わりに以下で担保:

- **unit test**: `notif-suppress` ロジック + 通知 embed の整形 (Step 4 で追加)
- **コードレビュー**: `handlers/snapshot-retention.ts` / `handlers/cleanup.ts` の AWS API 失敗
  パスから webhook が呼ばれるか
- **(任意) 擬似失敗実験**: 一時的に Worker 内で fake error を throw させて Discord に届く
  ことを確認する → 本番 Worker に test code を一時混入することになるので推奨しない

Step 4 で詳細手順を本書に追記する。

## 確認まとめ

| 項目 | 確認方法 | 合否 |
|---|---|---|
| A. idle 停止 → 📴 embed | sidecar 経路で 10 分放置 → Discord channel 観察 | (記入) |
| B. Spot 中断 → 🚨 embed | `send-spot-instance-interruption` 発火 → Discord channel 観察 | (記入) |
| C. snapshot 失敗 → ⚠️ embed | unit test + コードレビューで代替 (Step 4) | (記入) |
| 既存 Budget アラートが回帰せず動く | `inferSeverity` warning 判定 + embed 投稿 | (記入) |

確認完了後、`docs/phase4-plan.md` §完了基準のチェックボックスを更新する。
