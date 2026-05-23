# Phase 3 実装計画 — 自動停止 (sidecar + idle 検知)

最終更新: 2026-05-23 (新規)

## このドキュメントについて

design.md §10 **Phase 3: 自動停止** を実行するための計画。Phase 2 で registry 駆動レイヤーが
整い、ATM11 は `PAUSE_WHEN_EMPTY_SECONDS: 60` (itzg/minecraft-server のネイティブ機能) によって
プレイヤー 0 で CPU 消費は抑えられるが、**EC2 は起動したまま** で Spot 料金が積み上がる。
Phase 3 では sidecar が idle を検知して Worker に通知 → `/stop` フロー (snapshot 作成 + EC2
terminate) を発火させ、**放置で勝手に料金が止まる** 状態に持っていく。

> **進捗 (2026-05-23)**: 計画起こし完了、未着手。**公開前必須** (友人内クローズドでもコスト
> 保全のため最優先、design.md §10 Phase 3 参照)。

## 関連ドキュメント

- [docs/design.md](design.md) §3.3 (idle 検知アダプタ) / §4.1 (sidecar エンドポイント) / §4.4 (sidecar HMAC) / §4.6 (Worker 通知集約) / §5.5 (Snapshot ライフサイクル) / §10 Phase 3
- [docs/phase2-plan.md](phase2-plan.md) — 前段の registry 駆動化 (完了)
- [docs/iac-migration-plan.md](iac-migration-plan.md) Step 6 — snapshot 世代管理 Worker Cron (実装済、本 Phase で再利用)
- [CLAUDE.md](../CLAUDE.md) §Worker のコード / §AMI

## ゴール

> **ATM11 を `/start` 後にプレイヤーが切断 → `timeout_min` (10 分) を超えて誰も来ない →
> sidecar が Worker に idle 通知 → `/stop` 同等のフローで snapshot + terminate が走り、EC2
> 料金がゼロになる。手動 `/stop` を打たなくても放置で停止する。**

design.md §10 Phase 3 の 4 項目 (sidecar 実装 / idle → 停止フロー / snapshot 世代管理 ※既存
Cron 再利用 / Workers cron フォールバック) を満たす。

## 決定事項 (2026-05-23 起案、要確認項目は §Open Questions)

- **決定1: sidecar は Node.js 22 LTS / TypeScript / Docker**。design.md §6.1 「sidecar = Node.js
  / TypeScript (Docker container)」に従う。Worker と型共有可能、idle adapter 別の実装も TS の
  union 型で素直に書ける。AMI 内 Docker runtime も既に動いている。
- **決定2: sidecar イメージは AMI に焼き込む**。`launcher/sidecar/` に Dockerfile を置き、
  Packer で `gs-game-servers-*` AMI の `/var/lib/sidecar-image.tar` (or local registry) に同梱。
  ゲーム別ロジックは含まないので 1 イメージで全ゲーム対応 (design.md §3.3 「ゲーム別の差異は
  sidecar 内のアダプタ層に閉じる」の路線)。これにより AMI 再ビルドが Phase 3 で **1 回必要**。
  ECR / GHCR pull 案を比較した結果 AMI 焼き込みを採用した理由 (2026-05-23 議論):
  ① ECR pull は NAT or VPC endpoint で月 ¥3,000+ かかり月コスト目標 ¥700 を壊す、
  ② 起動時の外部依存 (ECR/GHCR pull) を 1 段階減らせる (idle 自動停止 = コスト保全の信頼性
  インフラなので外部依存を増やすのは本末転倒)、③ 新 adapter 追加は **新ジャンルのゲーム追加
  と同時** にしか起こらず、その作業の一環で AMI 再ビルドを回すなら反復速度のデメリットは
  実質ゼロ、④ `al2023-docker-compose` memory にあるとおり AMI に外部成果物を焼き込む路線は
  既に取っている。Phase 3 リリース直後の sidecar 共通部のバグ修正だけは AMI 再ビルドを許容
  する (年数回ペースに収束する想定)。
- **決定3: sidecar は cloud-init から `docker run` で起動、docker-compose は使わない**。本番
  EC2 の起動経路は user-data の cloud-init script に統一されている (`docker-compose.yml` は
  「Phase 1 ローカル検証用」と明記)。sidecar の起動も user-data に `docker run` 行を追加。
  ローカル検証用に `launcher/images/atm11/docker-compose.yml` にも sidecar サービスを追加する
  (副次的、本番経路ではない)。
- **決定4: 認証は HMAC SHA-256 共有秘密 (game 別)**。design.md §4.4 / §9 に従う。秘密は SSM
  Parameter `/gs/<game_id>/sidecar_hmac_secret` (SecureString) + Wrangler secret に同じ値を
  置く。payload に `timestamp` を含め、Worker 側で `±5 分` の skew 内のみ受理 (replay 防止)。
  sidecar は IMDSv2 で `game_id` を tag から取得し、SSM から秘密を引く。
- **決定5: heartbeat は 60 秒間隔 (registry の `heartbeat_interval_sec`)、idle 判定は
  sidecar 側で行い結果のみ送る**。Worker は heartbeat の都度 `SERVER_STATE.last_seen` を更新
  するだけで、idle 判定ロジックは sidecar に閉じる (registry の `idle_check.config` を解釈
  するのは sidecar の責務、Worker は判定結果を信頼する)。
- **決定6: フォールバック Cron は `*/5 * * * *` (既存 cron に相乗り)**。`last_seen` が
  `now - (timeout_min + 5min)` より古ければ sidecar 沈黙とみなして強制停止。これにより
  sidecar クラッシュ時もコスト保全される。新しい cron エントリは作らず、既存 5 分 cron に
  ハンドラを追加する (Worker invocation 数は変わらない)。
- **決定7: `/stop` の内部実装を再利用、`/sidecar/idle-detected` も同じ async フローを発火**。
  `handleStopCommand` から AWS 呼び出し部 (terminate + snapshot create + DNS reset + KV 更新)
  を `runStopWorkflow(env, game)` として切り出し、sidecar ハンドラと Cron フォールバックも
  ここを呼ぶ。Discord 応答だけが分岐する。
- **決定9: テスト基盤として vitest を Step 1 で導入する**。HMAC のようなフォーマット間違いが
  即バグになる暗号系ヘルパは仕様をテストで固める。`vitest` 1 つ追加、設定は `vitest.config.ts`
  最小、`pnpm test` を script に追加。Phase 3 以降の handler / adapter にも単体テストを書ける
  土台とする。`@cloudflare/vitest-pool-workers` 等の重装備は導入しない (HMAC は Web Crypto
  でも Node でも動く純粋関数のため)。
- **決定10: HMAC payload の正規化** (Open Question 解決 2026-05-23):
  - POST: `payload = "${timestamp}\n${body_utf8}"` (LF 1 文字、body は raw のまま改変なし)
  - GET: `payload = "${METHOD}\n${path_with_query}\n${timestamp}"` (例: `GET\n/sidecar/registry?game_id=atm11\n1736000000`)
  - HTTP ヘッダ: `X-Sidecar-Timestamp` (Unix 秒文字列) / `X-Sidecar-Signature` (HMAC-SHA256 を **standard base64** で encode)
  - timestamp skew は ±300 秒、`now - timestamp` の絶対値で判定
- **決定11: 重複発火防止** (Open Question 解決 2026-05-23):
  - `SERVER_STATE` に `stop-in-progress:<game_id>` キーを `runStopWorkflow` 冒頭で `put`、`finally` で `delete`。TTL 600 秒 (異常系の hang 保険)
  - 既存キー検出時は `{status: 'already-stopped', reason: 'in-progress'}` で即 return
  - KV の eventual consistency により短時間レースは残るが、sidecar 発火 vs cron-fallback (5 分窓) / Discord 手動 vs sidecar (操作頻度) の現実的な発火間隔では実用上十分
  - `SERVER_STATE` は本決定により Phase 3 から **必須 binding** に格上げ (`env.ts` の `SERVER_STATE?` → `SERVER_STATE`)。binding 自体は Phase 1 から本番設定済 (`wrangler.toml`)
- **決定8: sidecar が registry を取得する経路は Worker の専用 GET エンドポイント**。
  Worker が `GET /sidecar/registry?game_id=<id>` を HMAC 認証付きで提供し、sidecar は起動時に
  1 回だけ取りに行く。KV を source of truth のまま維持 (`register-game.mjs` の出力先を増やさない)、
  registry 変更は次回 `/start` で即反映。user-data 直接埋め込み案や SSM Parameter 案も比較したが、
  ① user-data 埋め込みは registry 変更で sidecar 再起動が要る、② SSM 案は KV と SSM をダブル
  source of truth にしてしまう、という欠点で却下 (2026-05-23 議論)。

## スキーマ / 設定変更

`workers/discord-handler/src/lib/registry/types.ts` の `idle_check` は既に Phase 2 で
最終形 (`type` / `timeout_min` / `heartbeat_interval_sec` / `config`)。Phase 3 では **変更しない**。

`games/atm11/registry.json` も `idle_check` を既に保持しているため変更不要。新規ゲームは
`_template/registry.json` の `idle_check` をコピーすれば動く設計。

SSM Parameter の新規追加 (Step 5 で作成):

| Path | 種別 | 用途 |
|---|---|---|
| `/gs/atm11/sidecar_hmac_secret` | SecureString | sidecar ↔ Worker 通信の HMAC 共有秘密 (game 別) |

Worker secret の新規追加 (Step 5 で投入):

| Name | 用途 |
|---|---|
| `SIDECAR_HMAC_SECRETS` | game_id → secret の JSON マップ (Worker 側は KV ではなく secret に持つ。KV 直読みより速い + secret rotation で一括更新できる) |

## 全体方針

1. **Worker 側を先に実装**。エンドポイントが無いと sidecar の動作確認ができない。逆 (sidecar
   が先) は curl で代替可能だが手間。
2. **段階的に統合**。Step 6 まで AMI を触らず、Worker / sidecar コードのローカル単体動作を
   確認してから AMI 再ビルド (Step 7) に進む。AMI 再ビルドは時間がかかるため反復回数を最小化。
3. **回帰確認は ATM11 のみ**。Vanilla 等は Phase 6 でやる。Phase 3 のゴールは「ATM11 で
   idle → 自動停止が走る」までで、新ゲームでの実証は Phase 6 と組み合わせる。
4. **Phase 1 の手動 `/stop` 経路は壊さない**。sidecar 経路は **追加**、既存の `/stop atm11`
   は引き続き動く (Discord 即時操作の選択肢として残す)。

---

## 実装ステップ

### Step 1: Worker 共通基盤 — HMAC 認証ヘルパ + stop ワークフロー切り出し  *(完了 2026-05-23)*

sidecar ハンドラ実装の前提となる横断ロジック。

- [x] **vitest 導入** (決定9): `package.json` に `vitest@^2.1.8` devDep + `pnpm test` / `pnpm test:watch` script、`vitest.config.ts` 最小設定 (`environment: node`、`src/**/*.test.ts`)
- [x] `workers/discord-handler/src/lib/auth/hmac.ts` 新規: HMAC-SHA256 を Web Crypto API (`crypto.subtle`) で計算するヘルパ群 (`formatPostPayload` / `formatGetPayload` / `signHmac` / `verifyHmac`)。`verify` は `crypto.subtle.verify` の timing-safe 比較を利用
- [x] `workers/discord-handler/src/lib/auth/hmac.test.ts`: 10 ケース (POST/GET payload format、skew boundary 内外、改竄、別 secret、不正 base64、GET 正規化)
- [x] `handlers/discord/stop.ts` から AWS 呼び出し部を `workers/discord-handler/src/handlers/stop-workflow.ts` の `runStopWorkflow(env, game, opts)` に切り出し。`opts = {triggeredBy, onProgress?, expectedInstanceId?}` で戻り値は `StopWorkflowOutcome` discriminated union (`ok` / `already-stopped` / `failed`)。`handleStopCommand` は `renderOutcome` で Discord 応答整形のみ担当
- [x] 決定11 の `stop-in-progress:<game_id>` ロックを `runStopWorkflow` 内で実装 (TTL 600 秒、finally で必ず delete)。`SERVER_STATE` 必須化に伴い stop.ts / start.ts / aws-notification.ts / cleanup.ts の `if (env.SERVER_STATE !== undefined)` 分岐を削除
- [x] `env.ts` に `SIDECAR_HMAC_SECRETS` (string、JSON map `{<game_id>: <base64 secret>}`) を必須 secret として宣言。`SERVER_STATE?` → `SERVER_STATE` (必須)
- [x] `wrangler.toml` のコメント: `SIDECAR_HMAC_SECRET` → `SIDECAR_HMAC_SECRETS` (複数形、JSON map である旨追記)
- [x] `pnpm typecheck` / `pnpm test` (10 tests pass) / `pnpm build` (dry-run) 通過

Worker コード変更: **あり (リファクタ + 新規ヘルパ + テスト基盤)**。挙動変化なし (まだルーティング配線せず、`/sidecar/*` は Step 2)。

### Step 2: Worker — `/sidecar/*` ハンドラ実装 (heartbeat / idle-detected / registry)  *(完了 2026-05-23)*

- [x] `handlers/sidecar/auth.ts` 新規 (共通認証ヘルパ): `verifySidecarPostRequest` / `verifySidecarGetRequest`。`SIDECAR_HMAC_SECRETS` を JSON parse して該当 game の secret を引き、決定10 の payload 正規化で `verifyHmac` を呼ぶ。失敗理由は `missing-headers` / `invalid-body` / `missing-game-id` / `unknown-game` / `invalid-signature` / `misconfigured-secrets` の discriminated union
- [x] `lib/state/last-seen.ts` 新規: `storeLastSeen` / `getLastSeen` / `deleteLastSeen`。キーは `last-seen:<game_id>`、TTL は handler 側で `timeout_min * 60 * 3` 秒を計算して渡す
- [x] `handlers/sidecar/heartbeat.ts`: POST `/sidecar/heartbeat`、auth → 204、KV に `{instanceId, lastSeenAt, playerCount}` を上書き
- [x] `handlers/sidecar/idle-detected.ts`: POST `/sidecar/idle-detected`、auth → `ctx.waitUntil(runStopWorkflow({triggeredBy: 'sidecar', expectedInstanceId: body.instance_id}))` → 即時 202
- [x] `handlers/sidecar/registry.ts` (決定8): GET `/sidecar/registry?game_id=<id>`、auth → `getGame` JSON 返却、未登録 / `enabled=false` は 404
- [x] `index.ts` に 3 ルート配線 (POST/POST/GET)。`/sidecar/*` は HMAC 認証で守られるため CORS / Discord 署名は不要
- [x] テスト: `auth.test.ts` (12 ケース: 正常 POST/GET、ヘッダ欠落、不正 timestamp / body、unknown game、改竄、skew over、misconfigured secrets、tampered path)、`last-seen.test.ts` (4 ケース: round-trip + TTL 観測 + 欠如 + 壊れた JSON)
- [x] `pnpm typecheck` / `pnpm test` (26/26 pass) / `pnpm build` (dry-run) 通過

Worker コード変更: **あり**。デプロイは Step 8。`expectedInstanceId` ガードと registry 404 経路の handler レベルテストは KV/AWS mock が必要で本 Step では省略、Step 8 の実機確認に回す。

### Step 3: Worker — Cron フォールバック (sidecar 沈黙時の保険)  *(完了 2026-05-23)*

- [x] `handlers/idle-fallback.ts` 新規:
  - 判定ロジックを `decideIdleAction(game, lastSeen, now)` の **純粋関数** に切り出し、テスト可能化
  - `handleIdleFallback(env)`: `listGames` × `last-seen:<game_id>` を読み、`stop` action なら `runStopWorkflow({triggeredBy: 'cron-fallback', expectedInstanceId: lastSeen.instanceId})`
  - 閾値: `(timeout_min + 5) * 60_000` ms (FALLBACK_SKEW_MIN = 5)。`elapsed <= threshold` は許容 (境界での誤発火防止)
  - **重要**: `last_seen` キーが無い game は `skip:no-heartbeat`。`/start` 直後の sidecar 起動待ち / sidecar クラッシュ後の TTL 切れ どちらでも誤停止しない。本当に停止が必要なケースは Discord `/stop` か Spot 中断に任せる (設計を「`SERVER_STATE.current` の組」から「`last-seen` キーの存在で running を signal する」に変更、より単純)
- [x] `index.ts` の `scheduled` に `ctx.waitUntil(handleIdleFallback(env).then(() => undefined))` を追加 (既存 5 分 cron に相乗り、cron 数は変えない)
- [x] テスト: `idle-fallback.test.ts` (5 ケース: no-heartbeat / within-window / 沈黙超過 (stop) / 境界 (= threshold で skip) / invalid-data)。別 instance_id のスキップは `runStopWorkflow` の `expectedInstanceId` ガードで担保され、handler ユニットレベルではテストせず Step 8 実機確認に回す
- [x] `pnpm typecheck` / `pnpm test` (31/31 pass) / `pnpm build` (dry-run) 通過

Worker コード変更: **あり**。

### Step 4: sidecar コンテナ実装 (TS + minecraft_rcon adapter)  *(未着手)*

- [ ] `launcher/sidecar/` 新規ディレクトリ
- [ ] `package.json` (Node 22、deps: `rcon-client`, 標準 `crypto`/`fetch`、TS dev deps)
- [ ] `src/main.ts`: メイン loop
  - EC2 IMDSv2 で `game_id` (tag `Game`) と `instance_id` を取得
  - SSM から `/gs/<game_id>/sidecar_hmac_secret` と registry の `idle_check.config.password_source` を取得
  - registry を Worker に GET (sidecar は KV を持たない、Worker から JSON 取得) → idle_check 仕様を取得
  - `heartbeat_interval_sec` 毎に adapter.check() → Worker に heartbeat POST
  - 連続して `timeout_min` 分プレイヤー 0 → `/sidecar/idle-detected` POST
- [ ] `src/adapters/minecraft-rcon.ts`: `rcon-client` で `list` 実行 → `empty_pattern` 正規表現マッチで idle 判定。返り値 `{ player_count, idle: boolean }`
- [ ] `src/adapters/index.ts`: `idle_check.type` で adapter を分岐 (Phase 3 では `minecraft_rcon` のみ実装、他は `throw new Error('not implemented')` で Phase 6 / 将来へ)
- [ ] `src/hmac.ts`: Worker と同じ HMAC payload 形式 (`${timestamp}\n${body}`) で署名生成 (Worker と仕様を厳密に揃える)
- [ ] `Dockerfile`: multi-stage build (Node 22 alpine、`tsc` → 配布)。RCON 接続用の最小 image
- [ ] ローカルテスト: `docker compose up` でゲーム本体 + sidecar を起動し、プレイヤー 0 状態で heartbeat が Worker dev (`wrangler dev`) に届くことを確認

sidecar 側変更のみ。Worker / AMI 未変更。

### Step 5: SSM Parameter 作成 + Worker Secret 投入  *(未着手)*

- [ ] `aws ssm put-parameter --name /gs/atm11/sidecar_hmac_secret --type SecureString --value $(openssl rand -base64 32) --tier Standard` (32 byte ランダム)
- [ ] `wrangler secret put SIDECAR_HMAC_SECRETS` で `{"atm11":"<上の値>"}` を投入
- [ ] runbook に手順を追記 (`/gs/<game>/sidecar_hmac_secret` を新ゲーム追加時にも作る)
- [ ] `register-game.mjs` に SSM Parameter 作成ステップを追加するかは Open Questions

Worker / sidecar コード変更: なし。

### Step 6: docker-compose + user-data に sidecar 起動を組み込む  *(未着手)*

- [ ] `launcher/images/atm11/docker-compose.yml` に `sidecar` サービスを追加 (ローカル検証用)。ゲーム本体 `atm11` と同じネットワークで localhost RCON 接続できるよう設定。`stop_grace_period: 10s`
- [ ] `workers/discord-handler/src/lib/launcher/user-data.ts` の `buildUserData` に sidecar 起動を追加:
  - `docker run -d --name sidecar --network host -e GAME_ID=<id> -e WORKER_URL=<base_url> --restart unless-stopped <sidecar_image_ref>` (host network で localhost:25575 RCON にアクセス、SSM 取得は IMDSv2 経由)
  - sidecar イメージ参照は AMI 内のローカル tar から `docker load` した後の固定タグ (例: `gs-sidecar:latest`)
- [ ] `user-data.test.ts` 既存テストに sidecar 行が含まれるアサーションを追加
- [ ] `pnpm typecheck` 通過

Worker コード変更: **あり**。デプロイは Step 8。

### Step 7: AMI 再ビルド (sidecar イメージ焼き込み)  *(未着手)*

- [ ] `ami/` の Packer 定義に sidecar イメージのビルド + `docker save` → AMI 内 `/var/lib/sidecar-image.tar` 配置を追加。cloud-init で `docker load -i /var/lib/sidecar-image.tar` してから `docker run` する流れ
- [ ] `packer build` で新 AMI 発行 → AMI ID を Terraform 変数 (or SSM Parameter) で参照させて Launch Template を更新 (`infra/modules/launch-template/` の `image_id` 経路)
- [ ] terraform plan で Launch Template の新 `image_id` 差分を確認 → apply
- [ ] 新 AMI で空 EC2 を起動して `docker images` / `docker run gs-sidecar --version` の動作だけ単体確認 (Worker 連携は Step 8)

Infra 変更: **あり** (新 AMI + Launch Template 更新)。`apply` は分類器のためユーザー実行 (memory: terraform-aws-credential-bridge)。

### Step 8: デプロイ + ATM11 実機確認  *(未着手)*

- [ ] `pnpm deploy` で Worker を本番反映 (sidecar ルート + Cron フォールバック含む)
- [ ] `/start atm11` → 起動完了 → sidecar が heartbeat を送り始めることを `wrangler tail` で確認
- [ ] プレイヤーが 1 人接続 → 切断 → 10 分放置
- [ ] sidecar から `/sidecar/idle-detected` が飛び、`runStopWorkflow` が走って ATM11 が停止することを確認 (Discord にも停止通知が届く設計なら確認)
- [ ] **Cron フォールバックの動作確認**: テスト用に sidecar を `docker stop sidecar` で殺した状態を再現し、`timeout_min + 5min` 後に Cron が `runStopWorkflow` を発火させることを確認 (heartbeat が来ない状態で last_seen が古くなる経路)
- [ ] 再 `/start atm11` で world が永続していることを確認 (snapshot 復元が壊れていないか回帰)

Worker / sidecar / AMI 変更: なし (デプロイのみ)。`wrangler deploy` と Discord 実機操作はユーザーが実施。

### Step 9: ドキュメント更新 + Phase 3 完了マーク  *(未着手)*

- [ ] `design.md` §10 Phase 3 の checkbox を埋め、完了マーク
- [ ] `design.md` §4.1 ルーティング図に `/sidecar/heartbeat` `/sidecar/idle-detected` が実装済として注記
- [ ] `CLAUDE.md` の §AMI に「sidecar 変更時も AMI 再ビルドが必要」を追記
- [ ] `runbook.md` に新ゲーム追加時の SSM Parameter (`sidecar_hmac_secret`) 作成手順を追加
- [ ] `phase3-plan.md` の各 Step を完了マーク

---

## 完了基準

- [ ] ATM11 で `/start` 後にプレイヤー 0 状態を `timeout_min` (10 分) 続けると、手動 `/stop` 無しで snapshot + terminate が走る (Step 8 で実機確認)
- [ ] sidecar を強制停止した状態でも Cron フォールバックが `timeout_min + 5min` 後に EC2 を停止する
- [ ] `/start` 直後の grace 期間 (heartbeat 未着の最初の 1〜2 分) で誤停止しない
- [ ] 既存の手動 `/stop atm11` が引き続き動く (回帰)
- [ ] design.md §10 Phase 3 の 4 項目すべて達成
- [ ] sidecar コードに `atm11` リテラルが無い (registry 駆動を死守、CLAUDE.md §やってはいけないこと)

## Phase 3 で扱わないもの (持ち越し)

- **`tshock_rest` / `steam_query` / `factorio_rcon` adapter 実装**: Phase 6 (新ゲーム追加実証) で該当 category を追加するときに同時実装。Phase 3 では `minecraft_rcon` のみ
- **player_count の長期 history KV** (design.md §4.3 「直近 50 件の起動・停止ログ」): Phase 4 (通知拡張) で扱う可能性。Phase 3 は `last_seen` のみで足りる
- **idle 検知通知の Discord webhook 整形**: 「自動停止しました」の Discord メッセージ整形は Phase 4 (通知拡張) のスコープ。Phase 3 では `runStopWorkflow` の既存通知経路を再利用するに留める
- **Worker OIDC 化**: Phase 5
- **新 sidecar イメージのレジストリ管理 (ECR 等)**: AMI 焼き込みで十分。レジストリ化は Phase 6 以降に再評価

## Open Questions

- [ ] **`register-game.mjs` に SSM Parameter 作成を含めるか**: 含めると新ゲーム追加が 1 コマンドで完結するが、`aws ssm put-parameter` は秘密値を扱うので CLI 経由で `openssl rand` を組み合わせる必要があり、idempotency (既存 secret を上書きしない) の設計が要る。Phase 3 では runbook に手動手順を書くだけにし、自動化は Phase 6 で再判断
- [x] **sidecar が registry を取得する経路** (確定 2026-05-23): Worker の専用 GET エンドポイント `/sidecar/registry?game_id=<id>` を採用。決定8 参照。Step 2 で実装 (sidecar ハンドラ群と同時)
- [x] **HMAC payload の正規化** (確定 2026-05-23): 決定10 参照。POST = `${timestamp}\n${body}` / GET = `${METHOD}\n${path_with_query}\n${timestamp}`、ヘッダは `X-Sidecar-Timestamp` / `X-Sidecar-Signature` (standard base64)
- [ ] **AMI ID の参照経路**: 新 AMI の ID を Worker / Launch Template にどう渡すか。SSM Parameter Store (`/gs/ami/latest`) に置いて Launch Template の `image_id` から `data.aws_ssm_parameter` 参照、が定石。Step 7 で確定
- [x] **Spot 中断と idle 停止の競合** (確定 2026-05-23): 決定11 参照。`SERVER_STATE.stop-in-progress:<game_id>` キー (TTL 600 秒) で `runStopWorkflow` が排他制御。Spot 中断側も同じ runStopWorkflow を呼ぶ前提なら同経路でロックが効く。KV の eventual consistency で短時間レースは残るが現実的な発火間隔では実用上十分
