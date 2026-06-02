# Runbook — Phase 7 admin-webui デプロイ

Phase 7 C-3 の本番デプロイ手順。**2 段階**に分け、既存 Discord 運用への影響を最小化する。

- **Phase A**: `admin-webui` Worker を単体デプロイ。discord-handler を触らないので **既存動作に影響なし**。SPA ロードと API 401 まで疎通確認できる。
- **Phase B**: `discord-handler` を再デプロイし `/panel`（magic link）を有効化。ここで初めてログイン → 編集が通る。既存コマンドのロジックは不変だが本番 Worker の再 publish なので `wrangler tail` 監視下で行う。

> デプロイは外向き操作。コマンドは**人間が実行**する（CI なし、手動 `wrangler deploy`）。

## 前提

- `wrangler login` 済み（未なら `! wrangler login` をセッションで実行）。対象 Cloudflare アカウントに zone `<base-domain>` がある
- `pnpm install` 済み（root）
- 値の出どころ（ローカルの `workers/discord-handler/wrangler.toml` は skip-worktree で実値が入っている）:
  - `GAME_REGISTRY` KV id / `SERVER_STATE` KV id … 同ファイルの `[[kv_namespaces]]`
  - base domain = `<base-domain>` → admin host = `gs-admin.<base-domain>`

---

## Phase A — admin-webui 単体（既存無影響）

### A-1. ADMIN_AUTH KV namespace を作成（本番）

```
cd workers/admin-webui
pnpm exec wrangler kv namespace create ADMIN_AUTH
```

> `--remote` フラグは無い。本番がデフォルト。出力された `id = "..."` を控える（= `<ADMIN_AUTH_ID>`）。

### A-2. admin-webui/wrangler.toml に実値を入れる（skip-worktree を先に）

`wrangler deploy` は KV id と独自ドメインを wrangler.toml から読むため、実値の記入は必須
（env 差し込みは不可）。実値を**誤ってコミットしない順序**で行う:

```
# 1) 先に git から隠す（placeholder のうちに skip-worktree。以降この file の変更は git が無視する）
git update-index --skip-worktree workers/admin-webui/wrangler.toml
```

```
# 2) それから placeholder を実値化（編集してももう git に拾われない）
#    routes        → pattern = "gs-admin.<base-domain>"
#    GAME_REGISTRY → id = discord-handler/wrangler.toml と同じ
#    SERVER_STATE  → id = discord-handler/wrangler.toml と同じ
#    ADMIN_AUTH    → id = A-1 で作った <ADMIN_AUTH_ID>
```

> KV id は秘密の credential ではないが（アカウント認証なしでは無意味）、公開リポジトリに
> 実値を載せない既存規約（discord-handler/wrangler.toml と同じ）に合わせて skip-worktree する。
> 規約に縛られないなら、単に編集してコミットしても機能上は問題ない。

### A-3. secrets を投入（admin-webui のみ）

`workers/admin-webui` で（各コマンドは値の入力を求める。自分のターミナルで実行）:

```
pnpm exec wrangler secret put CF_API_KEY
pnpm exec wrangler secret put ADMIN_DISCORD_USER_IDS     # 管理者 Discord user_id の CSV、最低 1 件
pnpm exec wrangler secret put PLAYER_DISCORD_USER_IDS    # プレイヤー CSV。admin 専用運用なら空文字でも可
```

### A-4. デプロイ（SPA build 結合込み）

```
pnpm run deploy        # = wrangler deploy。[build] が pnpm --filter admin-ui build を先に走らせる
```

> `pnpm deploy`（run なし）は pnpm 組込みコマンドに食われるので **`pnpm run deploy`** を使う。

### A-5. 疎通確認（既存は無傷）

- ブラウザで `https://gs-admin.<base-domain>/` → SPA が表示される
- 未ログインで API が弾かれる:
  ```
  curl -i https://gs-admin.<base-domain>/admin/api/games        # → 401 unauthorized
  ```
- Discord の `/start` `/stop` `/list` は**この時点で何も変わっていない**

ここまでで止めても既存運用に影響はない。ログイン → 編集を使うなら Phase B へ。

---

## Phase B — discord-handler 再デプロイ（/panel 有効化）

### B-1. discord-handler/wrangler.toml に 2 つ追加

ローカルの `workers/discord-handler/wrangler.toml`（既に skip-worktree）に追記:

```toml
[vars]
# ... 既存の vars はそのまま ...
ADMIN_BASE_URL = "https://gs-admin.<base-domain>"   # /panel が magic link を組み立てる

[[kv_namespaces]]
binding = "ADMIN_AUTH"
id = "<ADMIN_AUTH_ID>"                            # A-1 と同じ id を共有
```

> 既存 binding / vars は一切変更しない（追加のみ）。

### B-2. 監視しながらデプロイ

別ターミナルでログを流す:

```
cd workers/discord-handler
pnpm exec wrangler tail
```

別ターミナルでデプロイ:

```
cd workers/discord-handler
pnpm run deploy
```

> 既存コマンドのロジックは不変（diff は `/panel` case 追加 + 型の @gs/shared 移設のみ）。tail で `/list` 等が従来通り応答することを確認。

### B-3. `/panel` コマンドを登録（global）

```
DISCORD_BOT_TOKEN=<bot-token> DISCORD_APPLICATION_ID=<app-id> node scripts/register-discord-commands.mjs --global
```

> `integration_types=[0]`（Guild Install のみ）固定。global は反映に最大 1 時間。
> 早く試すなら `DISCORD_GUILD_ID=zzz` を付けて `--global` 無しで guild 即時登録。

### B-4. E2E 確認

1. Discord で `/panel` → 自分だけに見える ephemeral メッセージ + リンクボタン
2. ボタン → `gs-admin.<base-domain>/auth?t=...` → セッション cookie 発行 → `/` にリダイレクト
3. ゲーム一覧が**実データ**で表示される（ダミーバナーが出ないこと）
4. 1 件開いて `CF_FILE_ID` を編集 → 保存 → 200。KV に反映されることを確認:
   ```
   pnpm exec wrangler kv key get --binding GAME_REGISTRY <game_id>
   ```
   （`workers/discord-handler` か `workers/admin-webui` で実行）

---

## ロールバック

- admin-webui を消す: `cd workers/admin-webui && pnpm exec wrangler delete`（custom domain も解除される）
- discord-handler を戻す: `wrangler.toml` から `ADMIN_AUTH` bind と `ADMIN_BASE_URL` を外して再 `pnpm run deploy`
- `/panel` を消す: `register-discord-commands.mjs` から panel を外して再登録（または前の command セットで PUT 上書き）
- KV 誤書き込み: `node scripts/register-game.mjs <game_id>` で正データを再投入。world は EBS snapshot で保護

## 注意

- start/stop/status と新規追加（POST）と modpack 検索は**まだ 501**（E-2 / D-2 / D-1）。Phase B 後も admin-webui からは AWS/EC2 を一切起動しない = 実費は出ない。実 EC2 起動は D-3 から
- admin-webui は OIDC/AWS 鍵を持たない（ADR 0004）。万一侵害されても触れるのは共有 KV の編集まで
