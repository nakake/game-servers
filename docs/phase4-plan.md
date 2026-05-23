# Phase 4 実装計画 — 通知拡張 (idle 停止 / Spot 中断 / snapshot 失敗)

最終更新: 2026-05-24 (Step 3 完了 — Spot 中断専用整形 + aws-notification unit test + 実機検証 runbook)

## このドキュメントについて

`docs/design.md` §10 **Phase 4: 通知拡張** を実行するための計画。Phase 3 で sidecar 自動停止
が稼働したが、現状 sidecar / Cron-fallback 経由の停止は **Discord に何も通知されない** ため、
ユーザー (Discord 上で運用するプレイヤー) は ATM11 が落ちたことに気づかない。Phase 4 では
公開後のオペレーション可視性を確保するため、AWS 由来の異常イベントと Worker 内部イベントを
**Discord channel に集約** する。

> **進捗 (2026-05-23)**: 計画起こし完了、未着手。**公開前必須** (公開後のオペレーション
> 可視性、`design.md` §10 Phase 4 参照)。

## 関連ドキュメント

- [docs/design.md](design.md) §4.6 (AWS 通知の Discord 集約) / §10 Phase 4
- [docs/phase3-plan.md](phase3-plan.md) §Phase 3 で扱わないもの (idle 検知通知の Discord webhook 整形 — 本 Phase に持ち越し)
- [docs/iac-migration-plan.md](iac-migration-plan.md) Step 7 — EventBridge → SNS 配線 (実装済、本 Phase で Worker 整形側を充実)
- [docs/runbook-phase3-sidecar.md](runbook-phase3-sidecar.md) — sidecar 運用、本書 Phase 4 は通知整備の補完

## ゴール

> **ATM11 が放置で勝手に止まった / Spot 中断警告が来た / snapshot 削除に失敗した、いずれの
> イベントも 1 分以内に Discord channel に投稿される。** 通知メッセージは severity (critical /
> warning / info) で色分け + icon 付き、ユーザーが内容を一目で判別できる。

## スコープ

Phase 4 で **やる** (公開前必須):

| ID | 項目 | 由来 |
|---|---|---|
| **A** | idle 停止通知 (sidecar / cron-fallback 経由) → Discord | Phase 3 持ち越し |
| **B** | Spot 中断警告 (EventBridge → SNS → Discord) — 整形強化 + 実機検証 | design.md §10、IaC migration Step 7 で配線済 |
| **C** | snapshot 削除失敗通知 (Worker Cron) → Discord | design.md §10 |

Phase 4 で **やらない** (持ち越し):

- **D. 週次バックアップ完了通知** (info): design.md §5.5 で「Phase 3 以降」、週次 backup 自体が未実装。バックアップ実装と通知をセットで別 Phase
- **E. CloudTrail IAM ログイン異常検知**: 任意項目。運用しながら必要なら追加
- **F. player_count の長期 history KV**: デバッグ補助。運用中に必要が出てから

## 決定事項 (2026-05-23 起案)

- **決定1: スコープを A + B + C に絞る** (上記表参照)。D/E/F は公開後に運用を見て追加判断
- **決定2: Worker 内部イベント (A, C) は SNS を経由せず直接 Discord webhook (`env.DISCORD_WEBHOOK_URL`)**。SNS publish のために AWS SDK 呼び出しを追加するのは circular で oversize。AWS 由来 (B) は既存の SNS 経路をそのまま使う
- **決定3: Discord 整形は既存の `buildDiscordEmbed` / `inferSeverity` (`workers/discord-handler/src/handlers/aws-notification.ts`) と severity スキームを揃える**。Worker 内部イベント用にも同じ embed 形式 (icon + color + description) を出すヘルパーを切り出す
- **決定4: B (Spot 中断警告) は既存経路で動いている前提**。`inferSeverity` は subject に "interruption" を含めば critical 判定。`gs-spot-interruption-warning` EventBridge ルール (`infra/envs/prod/eventbridge.tf`) → SNS → Worker `/aws/notification` の経路は配線済 → **本 Phase の B は実機テスト + 必要なら整形の微調整**
- **決定5: 通知の連投抑制は最小限**。snapshot 失敗の連続発生時は KV `notif-suppress:<game>:<event>` で **1 時間 1 回まで** に絞る (TTL ベース)。これは Step 4 で判断、Phase 4 では idle 停止は連続発火しない (`runStopWorkflow` 1 回 = 1 通知) ため不要

## 全体方針

1. **webhook ヘルパーを先に独立化**。`aws-notification.ts` 内の `postWebhookMessage` を `lib/discord/webhook.ts` に切り出し、Worker 内部イベントから再利用できるようにする (Step 1)
2. **A を最優先で実装**。ユーザー要望の起点、`runStopWorkflow` への組み込みで完結 (Step 2)
3. **B は実装より検証**。既存経路で動く前提で、実機テスト中心 (Step 3)
4. **C は最後**。Worker Cron の失敗パス特定 + webhook 呼び出し (Step 4)
5. **回帰確認は ATM11 一本**。Phase 6 で新ゲーム実証する時に他 game でも通知が出ることを確認すれば良い

---

## 実装ステップ

### Step 1: Discord webhook ヘルパーを独立化  *(完了 2026-05-24)*

`postWebhookMessage` を `aws-notification.ts` の private 関数から `lib/discord/webhook.ts` の
公開 API に格上げ。

- [x] `workers/discord-handler/src/lib/discord/webhook.ts` 新規:
  - `postDiscordWebhookMessage(env, {content?, embeds?, mentionUserIds?})` を提供 (戻り値 `Promise<boolean>`、呼び出し側で SNS 502 再送判断が可能)
  - `env.DISCORD_WEBHOOK_URL` 未設定なら `console.warn` + 早期 return (Phase 1 の挙動踏襲)
  - response 失敗 / fetch throw は warn ログのみ、throw しない (通知失敗で Worker 全体は止めない)
  - `allowed_mentions.parse = []` を常時付与 (@everyone / role の暴発防止)
- [x] `aws-notification.ts` を新ヘルパー利用に書き換え:
  - 汎用 AWS アラート (embed POST) を `postDiscordWebhookMessage({embeds:[embed]})` 経由に
  - `deliverGameReady` の game-ready 通知 (content + mention) も新ヘルパー経由に
  - private `postWebhookMessage` を削除
  - 502 / 500 の status code 差別化は呼び出し側 (handleNotification) に残した (SNS 再送 vs 設定不備)
- [x] `lib/discord/webhook.test.ts`: 11 ケース (env undefined/empty、content only、embeds only、mentionUserIds、空配列の扱い、non-2xx、fetch throw、POST/JSON header)
- [x] `pnpm typecheck` / `pnpm test` (54 全通過) / `pnpm build` (227.65 KiB)

Worker コード変更: **あり (リファクタ + 新規 helper)**。挙動変化なし (既存 aws-notification の経路は同じ payload)。

### Step 2: idle 停止通知 (A) を runStopWorkflow に組み込む  *(完了 2026-05-24)*

`runStopWorkflow` の最後で `triggeredBy !== 'discord'` のとき Discord に通知する。

- [x] `lib/discord/notifications.ts` 新規: `buildIdleStopNotification(game, outcome, triggeredBy)` を純粋関数として提供
  - `status: 'ok'` → 📴 info embed (color `0x3498db`)、description で経路 + snapshot/volume/dns の状態を表示
  - `status: 'failed'` → ⚠️ warning embed (color `0xf39c12`)、エラー先頭 500 chars + 復旧ヒント
  - `status: 'already-stopped'` / `triggeredBy === 'discord'` → `undefined` (通知スキップ、ノイズ抑制と二重通知防止)
  - footer に instance ID、timestamp は ISO 文字列
- [x] `runStopWorkflow` を 2 層化 (`runStopWorkflow` = ラッパ、`executeStopWorkflow` = 既存ロジック)。早期 return が複数あるため inner 関数を抽出し、ラッパ側で outcome を受けてから通知 → return
- [x] Discord 経路は元 interaction の follow-up edit で通知されるため webhook 通知は出さない (`buildIdleStopNotification` 内で `triggeredBy === 'discord'` → undefined)
- [x] 通知の post 失敗は `postDiscordWebhookMessage` 側が throw しない契約、加えて `runStopWorkflow` 内でも try/catch で console.error (停止フロー本体は影響受けない)
- [x] テスト: `notifications.test.ts` 12 ケース (純粋関数なので AWS mock 不要)。Discord/already-stopped スキップ、ok 経路ラベル、各種 warning 分岐 (snapshot 失敗 / cleanup 失敗 / DNS 失敗)、failed 経路の error truncation + footer
- [x] `pnpm typecheck` / `pnpm test` (66 全通過) / `pnpm build` 通過

Worker コード変更: **あり**。デプロイは Step 5。

### Step 3: Spot 中断警告 (B) の整形強化 + 実機検証準備  *(コード完了 2026-05-24、実機は Step 5)*

既存経路 (`/aws/notification` → `inferSeverity = critical` → embed) が動いている前提で、
description 整形を Spot 中断専用に差し替えた。実機検証手順は Step 5 に集約。

- [x] **メッセージ整形強化**: `aws-notification.ts` に `isSpotInterruptionMessage(msg)` と
  `buildSpotInterruptionEmbed(msg)` を追加。EventBridge `input_template` の prefix
  (`"Spot interruption warning:"`) で検出し、description 先頭に「⚠️ 約 2 分以内に EC2 が
  Spot reclaim されます。今すぐ手動 `/stop` を…」を出す。原文 (instance-id / region / action)
  は `---` 区切りで残す。
- [x] **理由**: EventBridge input_transformer は SNS Subject を載せないため、generic 整形だと
  title が `🚨 AWS notification` になり一目で内容が分からない (調査済、`infra/envs/prod/eventbridge.tf` Step 9 調査)
- [x] **テスト**: `aws-notification.test.ts` 新規 9 ケース。`inferSeverity` の critical / warning / info
  判定、`isSpotInterruptionMessage` の prefix detection (case-sensitive、中間一致しない、
  unrelated alert false)
- [x] **実機検証手順**: `docs/runbook-phase4-notifications.md` 新規 §B に
  `aws ec2 send-spot-instance-interruption` のコマンド + 期待 embed + トラブルシュート観点
- [ ] **実機検証 (実行)**: Step 5 でユーザーが手元から発火させて Discord channel 観察
- [-] **(任意) 自動 graceful stop**: Phase 4 では入れない (design.md §11 Open Question、Phase 5+ で再評価)

Worker コード変更: **あり (専用整形 + helper export)**。Infra 変更: なし。

### Step 4: snapshot 削除失敗通知 (C)  *(未着手)*

Worker Cron (`handlers/snapshot-retention.ts` + `handlers/cleanup.ts`) で snapshot / volume の
DeleteSnapshot / DeleteVolume が失敗したとき、Discord に warning 通知を出す。

- [ ] `handlers/snapshot-retention.ts` の AWS API 呼び出し失敗パスを特定 (現状 console.error している箇所) → Discord webhook 呼び出しを追加 (`notifSuppress` で 1 時間 1 回に絞る)
- [ ] `handlers/cleanup.ts` の DeleteVolume 失敗パスも同様
- [ ] **連投抑制 (決定5)**: `lib/state/notif-suppress.ts` 新規 (or 既存 KV ヘルパー流用)。`notif-suppress:<game>:<event_type>` キーで TTL 3600 秒、`put` 成功時のみ通知を出す (Cron は 5 分間隔なので最悪 12 連投を 1 連投に圧縮)
- [ ] 通知 embed: warning (color `0xf39c12`、icon `⚠️`)、description に失敗 snapshot / volume ID、エラーメッセージの先頭 300 文字
- [ ] テスト: 連投抑制ロジックの unit test、Cron 失敗パスは AWS SDK mock が要るため省略 → 実機で確認

Worker コード変更: **あり**。

### Step 5: 実機検証  *(未着手)*

A / B / C をユーザーが手元で確認する。runbook 化する。

- [ ] **A**: `/start atm11` → 10 分放置 → idle 停止 → Discord channel に 📴 投稿
- [ ] **B**: `aws ec2 send-spot-instance-interruption --instance-ids <i-...>` → Discord channel に 🚨 critical embed
- [ ] **C**: 意図的に snapshot 失敗を起こすのは難しいので、unit test + code review で済ます。実機でフェイク失敗を起こすコマンド (例: 一時的に snapshot id を invalid に書き換える) は runbook に手順だけ示す
- [ ] runbook (`docs/runbook-phase4-notifications.md` 新規 or `runbook-phase3-sidecar.md` に追記) で 3 つの実機テスト手順を整備

### Step 6: ドキュメント更新 + Phase 4 完了マーク  *(未着手)*

- [ ] `design.md` §10 Phase 4 の checkbox を埋め、完了マーク
- [ ] `phase3-plan.md` の「持ち越し」 idle 通知を「Phase 4 で実装済」に修正
- [ ] `phase4-plan.md` の各 Step を完了マーク
- [ ] (memory) Phase 4 完了 / Phase 5 (OIDC) 着手を `phase-roadmap-2026-05-23.md` に反映

---

## 完了基準

- [ ] ATM11 で idle 停止後 1 分以内に Discord channel に `📴` で停止通知が届く (Step 2 + 5 実機)
- [ ] Spot 中断シミュレーションで Discord channel に `🚨` critical 通知が届く (Step 3 + 5 実機)
- [ ] snapshot 削除失敗を含む Worker Cron 失敗が Discord に届く (Step 4、unit test 中心 + runbook 手順)
- [ ] 既存の Budget アラート / SNS subscription confirmation / SNS Spot 中断などが回帰せず動く (Step 1 リファクタの副作用確認)
- [ ] design.md §10 Phase 4 の項目すべて達成 (D/E/F は持ち越しと明記)

## Phase 4 で扱わないもの (持ち越し)

- **D. 週次バックアップ完了通知** (info、design.md §5.5): バックアップ実装と同時に別 Phase で
- **E. CloudTrail IAM ログイン異常検知** (任意): Phase 4 では入れない。運用しながら必要なら追加
- **F. player_count の長期 history KV**: デバッグ補助、運用中に必要が出てから判断
- **Spot 中断時の自動 graceful stop** (design.md §11 Open Question): Phase 4 では通知のみ。自動 stop の発火は Phase 5 以降で再評価
- **通知 dedup を完全な at-most-once に**: KV の eventual consistency と TTL ベース抑制で「ほぼ 1 回」を狙うが、厳密保証は本 Phase ではやらない

## Open Questions

- [ ] **snapshot 失敗の検知粒度** (Step 4): Worker Cron の例外を拾う方式と、AWS の EBS Snapshot Notification event (EventBridge) を SNS にも流す方式のどちらが運用上良いか。前者はシンプルだが Worker Cron 自体がコケると検知できない。後者は IaC 変更が要る。Phase 4 では前者で始め、運用で漏れが見えたら EventBridge も追加検討
- [ ] **idle 停止通知の文面**: stop 経路 (sidecar / cron-fallback) と詳細 (snapshot ID 等) をどこまで出すか。Step 2 設計時に最終化、ユーザー (友人) 視点で「次回 /start で再開できる」が伝わる文面が最優先
- [ ] **embed の言語**: 既存 aws-notification は日本語混在。Phase 4 でも日本語で揃える (運用ユーザー = ユーザー本人 + 友人、日本語想定)
