# Phase 2 実装計画 — ゲーム抽象化 (registry 駆動化)

最終更新: 2026-05-22

## このドキュメントについて

design.md §10 **Phase 2: ゲーム抽象化** を実行するための計画。Phase 1 で `discord-handler`
Worker は ATM11 をハードコードした最小実装になっており、これを **registry 駆動** に切り替えて
「ゲーム追加が登録ファイルだけで完結する」状態にする。

各 Step は独立して動作確認でき、Worker のコード変更の有無を明示する。Step 完了ごとに本
ドキュメントの該当 checkbox を埋めて進捗を見える化する (iac-migration-plan.md と同じ運用)。

> **進捗 (2026-05-22)**: 計画策定完了。Step 1〜4 完了 (`register-game.mjs` / スキーマ +
> registry バックフィル / `GAME_REGISTRY` KV 作成 + atm11 投入 / Worker を registry 駆動に
> 切替)。Step 5〜8 未着手。

## 関連ドキュメント

- [docs/design.md](design.md) §3 (ゲーム抽象化レイヤー) / §10 Phase 2
- [docs/iac-migration-plan.md](iac-migration-plan.md) — 前段の IaC 移行 (完了)。Step 9 (Cloudflare DNS の IaC 化要否) は本 Phase に移管された
- [games/_template/](../games/_template/) — ゲーム定義の雛形と各フィールドの説明
- [CLAUDE.md](../CLAUDE.md) §ゲーム追加・変更 / §Worker のコード

## ゴール

> **Vanilla 1.21 を `games/vanilla/` に追加 → `register-game.mjs` 実行 → `/list` `/start`
> `/stop` が動く。Worker のコード・`wrangler.toml`・Discord コマンド定義の編集が一切不要。**

design.md §10 Phase 2 の 3 項目 (KV 投入 / registry 駆動 / 2 個目のゲーム) をこれで満たす。

## 決定事項 (2026-05-22)

- **決定1: `register-game` は Node (`scripts/register-game.mjs`)**。クロスプラットフォーム、
  既存の `register-discord-commands.mjs` と一貫、`wrangler` / `aws` CLI と `fetch` を素直に
  呼べる。→ CLAUDE.md / design.md の `register-game.sh` 表記を `.mjs` に更新する (Step 8)。
- **決定2: Vanilla は `docker pull`**。`itzg/minecraft-server:java21` は公開イメージで、Vanilla
  1.21 は Java 21 で動くため自前ビルド不要。ATM11 は java25 タグが未整備で従来どおり build。
  build/pull の選択も registry 駆動にするため、スキーマに `image_source` を追加する (Step 2)。
- **決定3: ATM11 固有 env vars は registry へ全廃**。`ATM11_CF_RECORD_ID` /
  `ATM11_RCON_PASSWORD_SSM_PATH` / `ATM11_SNAPSHOT_ID` / `LAUNCHER_TARBALL_S3_URI` の 4 つを
  registry もしくは導出に寄せ、`wrangler.toml [vars]` から削除する (Step 4)。
- **決定4: seed snapshot は registry の optional フィールドに**。新ゲームは seed を持たず
  blank EBS で初回起動する。Phase 0 の手動 snapshot (`<YOUR_SEED_SNAPSHOT_ID>`) は ATM11 の
  `seed_snapshot_id` に記録し、保険として残す。

## スキーマ変更

`workers/discord-handler/src/lib/registry/types.ts` の `GameDefinition` に追加:

| フィールド | 型 | 用途 |
|---|---|---|
| `image_source` | `"build" \| "pull"` | `build`=launcher tarball を取得して EC2 で `docker build` / `pull`=`container_image` を `docker pull` |
| `seed_snapshot_id` | `string \| null` (optional) | 初回起動の種 snapshot。`null` / 未指定なら blank EBS を `mkfs` して起動 |

`cf_record_id` は引き続きスキーマに存在するが、値は `register-game.mjs` が DNS レコード作成後に
書き戻す (`_template` は `"TBD_AFTER_REGISTRATION"` のまま)。

## 全体方針

1. **KV 未投入事故の回避**。`register-game.mjs` を先に作って KV を投入してから、KV を読む版の
   Worker をデプロイする。順序を逆にすると本番 Worker が空の KV を引いて全コマンドが壊れる。
2. **ATM11 回帰を Vanilla の前に**。Step 6 で KV 駆動版をデプロイした直後に `/start atm11` →
   `/stop atm11` で既存挙動の回帰を確認し、それから Step 7 で新ゲームを足す。
3. **registry 駆動を死守**。build/pull・ポート・snapshot 世代などゲーム差はすべて
   `registry.json` に寄せ、Worker のコードに `atm11` / `vanilla` リテラルを残さない。
4. **持ち越しの明示**。Phase 2 で扱わないものを末尾に列挙する。

---

## 実装ステップ

### Step 1: `register-game.mjs` 実装  *(完了 2026-05-22)*

ゲーム定義を外部リソースに反映するスクリプト。入力は `games/<game_id>/registry.json`。

- [x] `scripts/register-game.mjs` 作成。使い方: `node scripts/register-game.mjs <game_id> [--dry-run]`
- [x] **① Cloudflare DNS**: `<subdomain>.<base_domain>` の A レコードを作成 (content は
      placeholder `0.0.0.0`、実 IP は Worker が `/start` で更新)。既存なら作成せず取得のみ。
      取得した record_id を `games/<id>/registry.json` の `cf_record_id` に書き戻す
      (空行などの整形を壊さないよう値だけ正規表現置換)
- [x] **② S3 config sync**: `games/<id>/config/` を `config_s3_prefix` に `aws s3 sync`
      (`*.bak` は除外。`config/` が空ならスキップ)
- [x] **③ KV 投入**: `wrangler kv key put --binding GAME_REGISTRY --remote <game_id> --path <registry.json>`。
      `--namespace-id` ではなく `--binding` を使い、namespace ID は `wrangler.toml` から解決させる
      (ID の二重管理を避ける)。binding 未追加 (Step 3 前) なら分かりやすく停止する
- [x] `--dry-run`: 実リソースを変更せず実行内容だけ表示。token 未設定でもオフラインで preview 可
- [x] 冪等性: `ensureDnsRecord` が name で既存レコードを引いてから作成 (二重作成しない)

> 実装完了。`--dry-run` / 引数バリデーション / binding 検出をオフラインで動作確認済。live な
> Cloudflare DNS 作成・KV put・S3 sync は秘密情報と本番リソースを伴うため、Step 3 (atm11 投入)
> と Step 7 (vanilla 登録) で実機検証する。

環境変数 (実行時に渡す): `CLOUDFLARE_DNS_API_TOKEN` (必須)。`CLOUDFLARE_ZONE_ID` /
`CLOUDFLARE_BASE_DOMAIN` は省略時 `wrangler.toml [vars]` から読む。AWS 認証はローカル `aws`
CLI、Cloudflare アカウント認証はローカル `wrangler` に委譲。

Worker コード変更: なし。

### Step 2: スキーマ更新 + registry.json バックフィル  *(完了 2026-05-22)*

KV に投入する前に `registry.json` を最終形にする (Step 3 の投入を 1 回で済ませる)。

- [x] `types.ts`: `GameDefinition` に `image_source` (必須) と `seed_snapshot_id?` を追加
- [x] `games/atm11/registry.json`: `cf_record_id` を実値 `<YOUR_CF_RECORD_ID>` に /
      `seed_snapshot_id: "<YOUR_SEED_SNAPSHOT_ID>"` / `image_source: "build"`
- [x] `games/_template/registry.json`: `image_source: "pull"` と `seed_snapshot_id: null` を追加
- [x] `games/_template/README.md`: 新フィールド 2 つの説明を追記。あわせて手順ブロックの
      stale な `register-game.sh` 参照を `register-game.mjs` に修正 (実装済のため)
- [x] `pnpm typecheck` 通過 (Worker はまだ `atm11.ts` の build-time import のまま、挙動変化なし)

Worker コード変更: `types.ts` の型定義のみ。挙動変化なし。

### Step 3: `GAME_REGISTRY` KV 作成 + atm11 投入  *(完了 2026-05-22)*

- [x] `wrangler kv namespace create GAME_REGISTRY` で namespace 発行
      (`<YOUR_KV_GAME_REGISTRY_ID>`)
- [x] `wrangler.toml` の `[[kv_namespaces]]` (コメントアウト) を有効化し id を記載
- [x] `env.ts` の `GAME_REGISTRY` binding を有効化。`SERVER_STATE` と違い**必須** binding
      として宣言 (registry が無いと全コマンドが機能しないため graceful degradation しない)
- [x] `node scripts/register-game.mjs atm11` で atm11 を KV に投入 (Worker はまだ
      `atm11.ts` の build-time import のまま = 本番無害)
- [x] `register-game.mjs` の出力で KV 書き込み成功を確認 (read 検証は Step 6 の `/list` で実施)

> 実行中に `register-game.mjs` のバグを 2 件修正: ① KV stage で bare `wrangler` を呼んで
> いたが devDependency のため `pnpm exec` 経由に / ② `wrangler kv key put` に存在しない
> `--remote` フラグを付けており key 位置引数が食われていたため削除 (`kv key put` はデフォルト
> で remote 対象)。あわせて外部コマンド失敗時に Node のスタックトレースではなく 1 行の
> エラーを出すよう `run()` を改善。

Worker コード変更: `env.ts` の binding 宣言のみ。挙動変化なし (デプロイは Step 6 まで保留)。

### Step 4: Worker を registry 駆動に切替  *(完了 2026-05-22)*

本 Phase で最大の変更。`atm11.ts` の build-time import を KV 読み出しに置き換える。

- [x] `lib/registry/store.ts` 新規: `getGame(kv, id)` / `listGames(kv)`。`KVNamespace` を直接
      受け取る (`Env` 全体ではなく) — `lib/state/pending-*.ts` と同じ流儀
- [x] `lib/registry/atm11.ts` を削除
- [x] consumer を `store.ts` 経由に切替: `handlers/discord/list.ts` / `start.ts` / `stop.ts` /
      `handlers/snapshot-retention.ts` / `handlers/aws-notification.ts`
- [x] handler の async 化: `discord.ts` の `dispatchCommand` を `Promise<Response>` に /
      `handleListCommand` / `handleStartCommand` / `handleStopCommand` を async に
      (KV get を await してから deferred/error を返す。KV get は数 ms で 3 秒制約内)
- [x] `stop.ts` の `?? 'atm11'` デフォルトを撤去 (game 引数省略時はエラー応答)
- [x] env vars 移管:
  - `ATM11_CF_RECORD_ID` → `game.cf_record_id`
  - `ATM11_RCON_PASSWORD_SSM_PATH` → `game.env.RCON_PASSWORD_FROM_SSM` (registry に既出)
  - `ATM11_SNAPSHOT_ID` → `game.seed_snapshot_id` (無ければ blank EBS)
  - `LAUNCHER_TARBALL_S3_URI` → `config_s3_prefix` の bucket + `launcher/<id>.tar.gz` で導出
        (`buildUserData` 内で導出)
- [x] `env.ts` / `wrangler.toml [vars]` から上記 4 vars を削除
- [x] `lib/aws/ec2.ts`: 変更不要 — `BlockDeviceMapping.ebs.snapshotId` は既に optional で、
      `buildRunInstancesParams` も未指定なら `Ebs.SnapshotId` を emit しない (= blank volume)
- [x] `lib/launcher/user-data.ts`:
  - `buildAtm11UserData` → `buildUserData` にリネーム。opts はゲーム差を `game` に集約し
    `{ game, awsRegion, formatBlankVolume, readyNotifySnsTopicArn?, fqdn? }` に簡素化
  - **blank EBS 対応**: `blkid` も partition も無い真の空ボリュームを `formatBlankVolume`
    true のとき `mkfs.ext4 -F` してから mount (snapshot 復元時は触らない — 最後の else のみ)。
    新規ボリュームは container (uid 1000) が書けるよう `chown` する
  - **pull 対応**: `image_source === "pull"` は tarball 取得 + `docker build` をスキップして
    `docker pull` → `docker run`。`build` は従来どおり tarball + `docker build`
- [x] あわせて `handlers/admin.ts` の `containerName ?? 'atm11'` を撤去 (containerName 必須化)
      — Worker ソースから最後の `atm11` リテラルを除去
- [x] `pnpm typecheck` / `wrangler deploy --dry-run` 通過 (bindings に GAME_REGISTRY が出現、
      ATM11_*/LAUNCHER vars が消えたことを確認)

Worker コード変更: **あり (大)**。デプロイは Step 6。

### Step 5: Discord コマンドの autocomplete 化  *(未着手)*

`/start` `/stop` の `game` 引数の静的 `choices` を撤去し、KV から動的に候補を返す
(design.md §4.1 が `APPLICATION_COMMAND_AUTOCOMPLETE → game choices from KV` を明記)。
これでゲーム追加時に Discord コマンドの再登録が不要になる。

- [ ] `scripts/register-discord-commands.mjs`: `/start` `/stop` の `game` option を
      `autocomplete: true` に変更、ハードコードした `choices` を削除
- [ ] `lib/discord/types.ts`: `APPLICATION_COMMAND_AUTOCOMPLETE` (type 4) と
      `APPLICATION_COMMAND_AUTOCOMPLETE_RESULT` (type 8) の enum を追加
- [ ] `handlers/discord.ts`: interaction type 4 を新ハンドラに振り分け
- [ ] `handlers/discord/autocomplete.ts` 新規: KV の `enabled` ゲームを type 8 で返す
- [ ] `pnpm typecheck` 通過

Worker コード変更: **あり**。

### Step 6: デプロイ + ATM11 回帰確認  *(未着手)*

- [ ] `register-discord-commands.mjs --global` を実行し autocomplete 版に再登録 (1 回限り)
- [ ] `pnpm deploy` (`wrangler deploy`) で Worker を本番反映
- [ ] `/list` に atm11 が表示される
- [ ] `/start atm11` → `/stop atm11` で Spot 起動・snapshot 作成・terminate を実機確認
      (KV 駆動への切替で既存挙動が壊れていないことの回帰テスト)
- [ ] `/start` `/stop` の引数入力時、autocomplete に atm11 が出る

Worker コード変更: なし (デプロイのみ)。`wrangler deploy` と Discord 実機操作はユーザーが実施。

### Step 7: Vanilla 1.21 追加 (実証)  *(未着手)*

Phase 2 のゴール検証。**ここで Worker のコードを 1 行も触らずに完結することを確認する。**

- [ ] `games/vanilla/` を `games/_template/` からコピー
- [ ] `registry.json` 編集: `game_id=vanilla` / `display_name` / `subdomain=vanilla` /
      `image_source="pull"` / `container_image="itzg/minecraft-server:java21"` /
      `instance_types` / `ebs_size_gb` / `env` (`TYPE=VANILLA`, `VERSION=1.21.x`) /
      `idle_check` / `seed_snapshot_id=null`
- [ ] SSM Parameter `/gs/vanilla/rcon_password` を SecureString で作成 (runbook の手順に準拠)
- [ ] `config/` にゲーム設定を配置 (Vanilla は最小、必要なら `server.properties`)
- [ ] `README.md` にゲーム固有メモを記述
- [ ] `node scripts/register-game.mjs vanilla` 実行 (DNS レコード作成 + S3 sync + KV 投入)
- [ ] `/list` に vanilla が出現
- [ ] `/start vanilla` — **blank EBS の初回 `mkfs` 起動** と **`docker pull` 経路** を実機確認
- [ ] `/stop vanilla` — snapshot 作成・terminate
- [ ] 再 `/start vanilla` で world が永続していることを確認
- [ ] **Worker のコード変更ゼロでここまで到達したことを確認** ← Phase 2 ゴール達成

Worker コード変更: なし (これが完了条件)。

### Step 8: ドキュメント更新 + Phase 2 末の再評価  *(未着手)*

- [ ] `CLAUDE.md`: `register-game.sh` → `register-game.mjs`、§ゲーム追加・変更のフロー更新
- [ ] `design.md`: §3.2 / §10 Phase 2 の `register-game.sh` 表記修正、Phase 2 checkbox を更新
- [ ] `design.md` §10 Phase 2 を完了マーク
- [ ] **Open Question 再評価** (design.md §11 / iac-migration-plan.md):
  - OIDC 移行のタイミング (Cloudflare Workers → AWS AssumeRole、design.md §5.6)
  - Cloudflare DNS の IaC 化要否 (iac-migration-plan.md Step 9 から移管された判断)

---

## 完了基準

- [ ] Vanilla を **Worker コード変更ゼロ**で追加・起動・停止できた (Step 7)
- [ ] `wrangler.toml` に `ATM11_*` / `LAUNCHER_*` のゲーム固有 vars が残っていない
- [ ] Worker のソースに `atm11` / `vanilla` の文字列リテラルが (コメントを除き) 無い
- [ ] `/start` `/stop` の autocomplete が KV から動的にゲーム候補を出す
- [ ] design.md §10 Phase 2 の 3 項目すべて達成

## Phase 2 で扱わないもの (持ち越し)

- **ポートの Terraform 生成** (iac-migration-plan.md Step 2 からの持ち越し): Vanilla も
  TCP 25565 で Security Group の変更が不要。別ポートのゲーム (Terraria 7777、Valheim UDP 等)
  が登場した時点で `network.tf` を registry 由来に一般化する。`register-game.mjs` は SG を
  触らない (SG は Terraform 管理 = スクリプトが触ると drift)
- **OIDC 移行** (design.md §5.6): 「Phase 2 末で再評価」と規定 → Step 8 で判断
- **新 Key Pair 発行** (iac-migration-plan.md Step 4 option): ゲーム追加と無関係、任意
- **週次 S3 バックアップ** (design.md §5.5): Phase 3 以降
- **sidecar / idle 自動停止**: Phase 3

## Open Questions

- [ ] **KV 反映の自動化**: 現状 `register-game.mjs` の手動実行のみ。CI で `games/**` 変更時に
  自動投入するかは Phase 4 (GitHub Actions) で再検討
- [ ] **KV の eventual consistency**: KV は最大 60 秒のグローバル伝播遅延がある。ゲーム定義は
  変更頻度が低く許容範囲。`register-game.mjs` 直後の `/list` 不一致は無視してよい
- [ ] **`enabled: false` のゲームの扱い**: `/list` と autocomplete からは除外する。`/start` は
  明示的に拒否する (`start.ts` に既存の `enabled` チェックあり)
