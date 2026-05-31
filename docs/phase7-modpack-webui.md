# Phase 7 実装計画 — Modpack 管理 WebUI

最終更新: 2026-05-31 (rev2: 独立した検証 Phase A を廃止、新規追加フローに検証を畳み込む)

## このドキュメントについて

CurseForge API key 取得 (2026-05-27) を受け、Minecraft modpack の **追加 / バージョン更新 / 起動操作** を Discord コマンドではなく **Web 管理画面 (admin SPA)** から行えるようにする計画。

Phase 6 で配線済の `AUTO_CURSEFORGE` 経路 (`games/atm10/registry.json` + `user-data.ts:71-87` の `*_FROM_SSM` 汎用ハンドラ) を前提に、その操作面を Web 化する。Worker 側のコア処理 (AWS 呼び出し / KV / DNS) は既存資産にほぼ全乗りできるため、Phase 7 の新規実装は **認証 + CF API client + 静的 SPA** の 3 ピースで完結する。

> **進捗 (2026-05-31)**: rev2、未着手。**AUTO_CURSEFORGE の独立検証 (旧 Phase A) は前提条件から外した**。理由は §10.0 を参照 — 要約すると「新規 modpack 追加フローは新 game_id = snapshot なし = 必ず空 EBS から起動するため、初回の実追加がそのまま AUTO_CURSEFORGE 検証を兼ねる」。Worker/UI 側の plumbing (CF API client / 認証 / KV CRUD / SPA) は EC2 起動の成否と独立なので、検証を待たずに着手可能。

## 関連ドキュメント

- [docs/design.md](design.md) §3 (registry スキーマ) / §4 (Worker 構成)
- [docs/conventions.md](conventions.md) §「ゲーム追加・変更」
- [docs/adr/0003-magic-link-auth.md](adr/0003-magic-link-auth.md) — 認証方式の判断記録
- `workers/discord-handler/src/lib/launcher/user-data.ts:71-87` — `*_FROM_SSM` 汎用ハンドラ (CF_API_KEY 経路)
- `workers/discord-handler/src/lib/registry/store.ts` — GAME_REGISTRY KV access
- `scripts/register-game.mjs` — Phase 7 で Worker 側に部分移植する対象

## 0. 背景

### 0.1 現状の運用フロー (Phase 6 まで)

新 modpack を追加するには:

1. `games/<new-game>/registry.json` を手書き
2. `games/<new-game>/config/server.properties` 等を手書き
3. ローカルで `node scripts/register-game.mjs <new-game>` 実行 (Cloudflare DNS + S3 sync + KV put)
4. `/start <new-game>` を Discord で叩いて検証

このフローには 3 つの摩擦がある:

- **メタデータの調査が人手**: modpack の Minecraft version / mod loader / 推奨 RAM を CurseForge web で目視確認
- **registry.json の手書き**: ports / instance_types / ebs_size_gb / env をテンプレートから写経
- **CLI 操作の連鎖**: token 環境変数の export + Node + wrangler の 3 ステップ

modpack の **バージョン更新** (例: ATM10 v3.10 → v3.11) も同様に registry.json の `CF_FILE_ID` 書き換え + KV put + `/start` という流れになる。Discord コマンドだけで完結させようとすると入力フォームが貧弱で、特に **検索 / 一覧 / RAM 数値入力** の UI 表現が破綻する (理由はユーザー指摘の通り)。

### 0.2 CurseForge API 調査結果 (要約)

| 項目 | 内容 |
|---|---|
| 認証 | `x-api-key: <key>` header |
| 基底 URL | `https://api.curseforge.com` |
| modpack 検索 | `GET /v1/mods/search?gameId=432&classId=4471&searchFilter=<keyword>` |
| modpack 詳細 | `GET /v1/mods/{modId}` (`latestFiles[]` を含む) |
| 全バージョン | `GET /v1/mods/{modId}/files` (`fileDate` / `releaseType` / `downloadUrl` / `gameVersions`) |
| 個別 DL URL | `GET /v1/mods/{modId}/files/{fileId}/download-url` |
| 制限 | page size 50 / 合計 10,000 件 / rate limit は未公開 |
| 注意 | distribution NG modpack は `downloadUrl=null` または 403 |

slug (例 `all-the-mods-10`) → modId 解決は search 経由で 1 発引き可。itzg 側は `CF_SLUG` で動くため Worker は modId をユーザーに見せる必要はないが、API 呼び出しの内部用には保持する。

## 1. ゴール / 非ゴール

### ゴール

- Discord ephemeral message → magic link → SPA の 1 クリック動線で管理画面に入れる
- modpack 検索 / バージョン選択 / 推奨 RAM 入力を **GUI form** で完結
- 既存ゲームの env (特に `CF_FILE_ID`, `MEMORY`, `VERSION`) を **画面から書き換えて** 次回起動に反映
- 新規 modpack 追加が **registry.json 手書きなし** で完了 (Cloudflare DNS / S3 / KV を Worker 経由で操作)
- start / stop / status を WebUI からも実行可能 (Discord と並列に共存)

### 非ゴール

- ゲーム削除 UI (まずは read-only、危険操作は Discord か手動で)
- snapshot / backup の操作 UI (Phase 8 候補)
- コスト / ログ可視化 (Phase 8 候補)
- モバイル最適化 (PC ブラウザ前提、レスポンシブ程度に留める)
- 複数 admin の RBAC (allowlist の単一ロール固定)

## 2. アーキテクチャ

```
[Discord]
   │  /admin
   ▼
[Cloudflare Workers] (gs-discord-handler、既存 Worker を拡張)
   │  ① ephemeral response + button URL に one-shot token
   ▼
[Browser] → https://<worker-host>/auth?t=<token>
   │  ② token 検証 → used=true → JWT cookie 発行 → / にリダイレクト
   ▼
[SPA] (Workers Static Assets として同 Worker に同居)
   │  /games           game 一覧
   │  /games/:id       env 編集 (update)
   │  /add             modpack 検索 → 新規追加
   │  /games/:id/ops   start / stop / status
   ▼ fetch (Cookie + X-Requested-With)
[Worker /admin/api/*]
   │  ③ cookie 検証 + allowlist チェック
   │  ④ KV / CF API / AWS API 呼び出し
   ▼
[KV: GAME_REGISTRY / SERVER_STATE]
[CurseForge API]
[Cloudflare DNS API]
[AWS API (既存の OIDC 経路)]
```

### 設計上の特徴

- **単一 Worker**: 既存 `workers/discord-handler/` に `/admin/*` routes を追加。Cloudflare Pages を別途立てない。Workers Static Assets binding で SPA も同 Worker から配信
- **Source of truth は Workers KV**: WebUI 操作は KV を直接書く。Git の `games/<id>/registry.json` は audit 用に monthly export スクリプトで反映 (詳細 §8)
- **Discord OAuth 不使用**: magic link 認証で Discord 既存 bot の認証に乗っかる (ADR 0003)

## 3. CurseForge API client

`workers/discord-handler/src/lib/curseforge/` 配下に薄いラッパを置く。`x-api-key` ヘッダを `fetch` で渡すだけなので SDK 不要。

### 3.1 必要メソッド

```typescript
interface CurseForgeClient {
  // gameId=432 (Minecraft) + classId=4471 (ModPacks) 固定で検索
  searchModpacks(keyword: string, opts?: { pageSize?: number }): Promise<ModpackSummary[]>;

  // slug → modId + メタデータ (latestFiles 含む)
  resolveSlug(slug: string): Promise<ModpackDetail | undefined>;

  // 全バージョンの paginated 取得 (UI 側は最新 20 件程度を見せれば十分)
  listFiles(modId: number, opts?: { pageSize?: number; index?: number }): Promise<ModpackFile[]>;
}

interface ModpackSummary {
  modId: number;
  slug: string;
  name: string;
  summary: string;
  thumbnailUrl?: string;
}

interface ModpackDetail extends ModpackSummary {
  latestFiles: ModpackFile[];
}

interface ModpackFile {
  fileId: number;
  displayName: string;     // 例: "ServerFiles-3.10"
  fileName: string;
  fileDate: string;        // ISO8601
  releaseType: 1 | 2 | 3;  // 1=release, 2=beta, 3=alpha
  gameVersions: string[];  // 例: ["1.21.1", "NeoForge"]
  downloadUrl: string | null;  // null なら distribution NG
}
```

### 3.2 API key の取得経路

Worker から CF API を叩く場面と EC2 上の itzg が叩く場面の **両方** が要る:

- **Worker 側**: 検索 / メタ取得用。Workers Secret `CF_API_KEY` を新規追加 (`wrangler secret put CF_API_KEY`)
- **EC2 側 (既存)**: 既に SSM SecureString `/gs/global/cf_api_key` 経由で `CF_API_KEY_FROM_SSM` ハンドラが処理済

両者で同一の key を使うが secret store は分離 (Workers Secret と SSM の二重保管)。理由: Worker から SSM を読むのは可能だが latency 増 + IAM policy 拡張が要るため、Worker 側は Cloudflare 内に閉じる方がシンプル。

## 4. 認証 (magic link)

ADR 0003 で確定した方式。詳細はそちらに譲り、ここでは仕様だけ:

### 4.1 Discord 側

新スラッシュコマンド `/admin` を追加:

- `flags: 64` (EPHEMERAL) で応答 — **必須、テストで担保**
- response 本体: `components: [{type:1, components:[{type:2, style:5, label:"管理画面を開く", url:"<ADMIN_BASE_URL>/auth?t=<token>"}]}]`
- token: 32 bytes CSPRNG (`crypto.getRandomValues`) → base64url
- KV `admin_token:<token>` = `{user_id, issued_at, exp_ts, used:false}` TTL 600s

### 4.2 Browser → Worker

`GET /auth?t=<token>` の処理:

1. KV `admin_token:<token>` を読む
2. `used === false && exp_ts > now` をチェック
3. **`used=true` で put** (race condition は許容、§9 で議論)
4. `ADMIN_DISCORD_USER_IDS` (CSV env) に `user_id` が含まれることを確認
5. JWT (HS256, 24h, `{sub:user_id, jti:<random>, exp}`) を `gs_admin_session` cookie に発行
   - `Secure; HttpOnly; SameSite=Strict; Path=/`
6. KV `admin_session:<jti>` = `{user_id, issued_at, exp_ts}` TTL 86400s (revoke 用)
7. HTML を返し、`<script>history.replaceState(null,'','/');location.href='/'</script>` で URL から `?t=` を消す

### 4.3 API リクエスト

- middleware: cookie → JWT 検証 → KV `admin_session:<jti>` 存在チェック → allowlist 再確認
- 状態変更 API (PUT/POST/DELETE) は `X-Requested-With: fetch` header を要求 (CORS preflight が立つ仕掛けで CSRF 軽減)

### 4.4 logout

`POST /admin/api/auth/logout`: KV `admin_session:<jti>` を delete + cookie clear。

Discord 側にも `/admin logout` を用意し、自分の全 jti を巡回 delete する経路を持たせる (デバイス紛失対策)。

## 5. データモデル

### 5.1 KV namespace の追加・流用

| Namespace | 用途 | Phase 7 で新規? |
|---|---|---|
| `GAME_REGISTRY` (既存) | game_id → registry.json | 流用 |
| `SERVER_STATE` (既存) | 起動状態 / pending_ready / notif_suppress | 流用 |
| `ADMIN_AUTH` (新) | `admin_token:*` / `admin_session:*` | **新規** |

`SERVER_STATE` に相乗りも可能だが、key prefix 衝突と TTL の独立性のため別 namespace を作る。`wrangler.toml` に binding を追加。

### 5.2 KV key 設計

| Key | Value | TTL |
|---|---|---|
| `admin_token:<token>` | `{user_id, issued_at, exp_ts, used:bool}` | 600s |
| `admin_session:<jti>` | `{user_id, issued_at, exp_ts}` | 86400s |
| `game:<game_id>` (既存 GAME_REGISTRY) | GameDefinition JSON | 無制限 |

### 5.3 GameDefinition の拡張

新規 game を Web から追加する場合、`registry.json` を生成するために以下フィールドが UI 入力対象になる:

```typescript
interface NewGameForm {
  // 一意 ID (URL safe)
  game_id: string;          // "atm10" など。kebab-case
  display_name: string;     // "All The Mods 10"
  subdomain: string;        // 既定で game_id と同じ

  // CurseForge 由来 (UI が自動入力)
  cf_slug: string;
  cf_file_id?: number;      // 未指定なら latest (itzg が自動解決)
  cf_modpack_meta: {        // UI に表示するためのキャッシュ。registry には保存しない
    modId: number;
    minecraftVersion: string;
    modLoader: 'NEOFORGE' | 'FORGE' | 'FABRIC' | 'QUILT';
  };

  // ユーザー入力 (推奨値を UI で提示)
  memory_gb: number;        // 例: 10
  instance_types: string[]; // 既定: ["r7a.large", "r6a.large"]
  ebs_size_gb: number;      // 既定: 30
  spot_max_price_jpy_per_hour: number | null;
  port: number;             // 既定: 25565
}
```

UI 側が `NewGameForm` → `GameDefinition` への変換を行う。変換ロジックは Worker 側 `lib/registry/build.ts` (新) に置き、`scripts/register-game.mjs` と共有可能にする。

## 6. API 仕様

すべて `/admin/api/` 配下、Cookie 認証必須。

| Method | Path | 用途 | 副作用 |
|---|---|---|---|
| `GET` | `/admin/api/games` | game 一覧 (KV scan) | なし |
| `GET` | `/admin/api/games/:id` | 単体取得 | なし |
| `PUT` | `/admin/api/games/:id` | env / instance_types / ebs_size_gb / spot_max_price 更新 | KV write |
| `POST` | `/admin/api/games` | 新規追加 (NewGameForm) | CF DNS A 作成 + S3 prefix 作成 + KV put |
| `POST` | `/admin/api/games/:id/start` | 起動 | 既存 `handleStartCommand` の中核ロジック呼び出し |
| `POST` | `/admin/api/games/:id/stop` | 停止 | 既存 `handleStopCommand` の中核ロジック呼び出し |
| `GET` | `/admin/api/games/:id/status` | 状態取得 | EC2 describe + KV state read |
| `GET` | `/admin/api/modpacks/search?q=` | CF API search proxy | CF API 1 call |
| `GET` | `/admin/api/modpacks/by-slug/:slug` | slug → 詳細 + バージョン一覧 | CF API 2 call |
| `POST` | `/admin/api/auth/logout` | session 失効 | KV delete |

### 6.1 既存 Discord handler との重複排除

`handleStartCommand` / `handleStopCommand` は現状 Discord interaction object を直接受け取っている。`/admin/api/games/:id/start` でも同じ処理を呼びたいので、**core ロジックを `lib/orchestrator/start.ts` (新) / `lib/orchestrator/stop.ts` (新) に切り出す**:

```
handlers/discord/start.ts  ── Discord 用 wrapper (3秒応答 + followUp)
handlers/admin/games.ts    ── Web 用 wrapper (JSON 応答 + 進捗 SSE or polling)
        ↓                            ↓
        └─── lib/orchestrator/start.ts (game, ctx, env, progressCallback) ───┘
```

進捗通知は Discord 側は `followUp.editOriginal`、Web 側は **polling で `/admin/api/games/:id/status` を叩く** (SSE は Workers でも可能だが MVP では polling で十分)。

## 7. SPA 構成

### 7.1 技術スタック

- **Framework**: Svelte 4 (SvelteKit ではなく Svelte + Vite 単体、static export 前提)
- **Build**: Vite → 出力 `workers/discord-handler/public/`
- **CSS**: Tailwind CSS (or 単純な custom CSS でも可、要件次第)
- **Forms**: 検証は zod (Worker 側と共有可能)

Svelte 採用理由: React/Vue より bundle size が小さく、SPA が ~30-50KB に収まる。Workers Static Assets は Cloudflare CDN から配信されるため重さは致命的ではないが、ロード速度はユーザー体感に直結。

### 7.2 ファイル配置

```
workers/discord-handler/
├─ public/                       # ← Vite build 出力 (gitignore)
├─ wrangler.toml                 # [assets] binding 追加
└─ src/
    ├─ handlers/
    │   ├─ admin/                # 新規
    │   │   ├─ auth.ts           # /auth, /admin/api/auth/logout
    │   │   ├─ games.ts          # /admin/api/games/*
    │   │   └─ modpacks.ts       # /admin/api/modpacks/*
    │   └─ discord/
    │       └─ admin.ts          # 新スラッシュコマンド /admin
    ├─ lib/
    │   ├─ curseforge/           # 新規
    │   │   ├─ client.ts
    │   │   └─ types.ts
    │   ├─ auth/
    │   │   └─ admin-session.ts  # 新規 (token issue/verify, JWT, allowlist)
    │   ├─ orchestrator/         # 新規 (start/stop の core ロジック切り出し)
    │   │   ├─ start.ts
    │   │   └─ stop.ts
    │   └─ registry/
    │       └─ build.ts          # 新規 (NewGameForm → GameDefinition 変換)

admin-ui/                        # 新規ディレクトリ (SPA source)
├─ src/
│   ├─ App.svelte
│   ├─ routes/
│   │   ├─ Games.svelte
│   │   ├─ GameDetail.svelte
│   │   ├─ AddGame.svelte
│   │   └─ GameOps.svelte
│   └─ lib/
│       └─ api.ts                # fetch wrapper (X-Requested-With 自動付与)
├─ package.json
└─ vite.config.ts
```

`admin-ui/` を build すると `workers/discord-handler/public/` に出力されるよう Vite を設定。CI で Worker deploy 前に `pnpm --filter admin-ui build` を実行する step を追加。

### 7.3 wrangler.toml の変更

```toml
[assets]
directory = "./public"
binding = "ASSETS"
# SPA は client-side routing なので 404 を index.html にフォールバック
not_found_handling = "single-page-application"

[[kv_namespaces]]
binding = "ADMIN_AUTH"
id = "..."
```

`src/index.ts` で `/admin/api/*` を Worker、それ以外を `ASSETS.fetch(request)` にディスパッチ。

## 8. Source of truth (KV 真、Git は audit 用)

### 8.1 基本方針

- **WebUI 操作は KV を直接書く**
- **Git の `games/<id>/registry.json` は audit / 災害復旧用**
- 既存 `scripts/register-game.mjs` は **Git → KV** 方向 (新規 game の初期投入や災害復旧時のみ) として残す
- 新規 `scripts/export-registry.mjs` で **KV → Git** 方向 (monthly run、`git diff` で audit) を作る

### 8.2 placeholder-skip-worktree との関係

`games/atm10/registry.json` は現在 [[placeholder-skip-worktree-workflow]] パターン (HEAD には placeholder、ローカルに実値、`git update-index --skip-worktree` で git から隠す) を採用している。

Phase 7 移行後の運用は以下のいずれか:

| 案 | 内容 | trade-off |
|---|---|---|
| **A. skip-worktree を維持** | export スクリプトは `--no-skip-worktree` で一時解除 → 上書き → `--skip-worktree` で再ロック | 既存 workflow に追加で複雑性が乗る |
| **B. skip-worktree を廃止し、`games/<id>/registry.json` を実値で commit** | KV を真とし、Git は audit のみなので機密性は KV 側 + Workers Secret 側に閉じる。GitHub Public でも実値が見えて問題ない fields に絞り込み済み | placeholder 撤廃 = 履歴を 1 度クリーンアップする必要 |
| **C. `games/<id>/registry.json` を export 専用にし、placeholder 版は `games/<id>/registry.template.json` に分離** | role 分離が明確 | ファイル 2 個になる |

**Phase 7 で決める**: 仮に B を推奨 (現状の registry.json で実値漏れになる field は `cf_record_id` 程度で、Cloudflare zone から逆引き可能 = 機密性低)。最終判断は実装前に再確認。

### 8.3 export スクリプトの設計

`scripts/export-registry.mjs`:

```
wrangler kv key list --binding=GAME_REGISTRY
  → 各 key (game:<id>) を wrangler kv key get で読む
  → games/<id>/registry.json に書き戻す (整形)
  → git diff を表示し、変更があれば PR-ready 状態にする
```

CI に組み込んで月 1 回自動 PR を作るのが理想だが、MVP では手動実行で OK。

## 9. セキュリティ考慮

ADR 0003 の議論を要約 + Phase 7 特有の項目:

### 9.1 自分で対策する項目

| # | リスク | 対策 |
|---|---|---|
| 1 | `/admin` 応答に EPHEMERAL flag を忘れる | unit test で `flags: 64` を assert |
| 2 | `ADMIN_DISCORD_USER_IDS` が空文字列で全許可になる | Worker init で `allowlist.length > 0` を assert、fail-closed |
| 3 | admin endpoint で auth check 漏れ | `withAdminAuth(handler)` middleware を全 endpoint に bolt-on |
| 4 | URL の token がブラウザ履歴に残る | `/auth` HTML で `history.replaceState` を即実行 |
| 5 | XSS による cookie 自動付与攻撃 | CSP `script-src 'self'` + 状態変更 API は `X-Requested-With` header 要求 |
| 6 | wrangler tail で `?t=xxx` が見える | `/auth` handler 内で token を log redact |
| 7 | KV の 1-shot 保証が race condition で破れる | KV は eventually-consistent。実害「同一ユーザーの 2 セッション」のみで軽微、許容 |
| 8 | session 24h が長すぎてデバイス紛失時に被害 | `/admin logout` (Discord 経由) で全 jti revoke 可能に |

### 9.2 自分では完全防御できないリスク

| # | リスク | 評価 |
|---|---|---|
| 9 | Discord アカウント侵害 | 2FA 必須運用。これは OAuth でも同等 |
| 10 | Cloudflare アカウント侵害 | 2FA + hardware key 必須運用。同上 |
| 11 | ブラウザ拡張による cookie 横取り | Web 共通の制約、対策困難 |

### 9.3 IAM 影響範囲

Phase 5 で OIDC + least privilege 化済 (`gs-game-server` role の policy が tag-bound)。WebUI 経由でも同じ role を使うので **新規の AWS 権限は増えない**。WebUI 経由の `start` / `stop` も既存 IAM 範囲内で完結。

ただし「新規 game 追加」で `RunInstances` を初めて叩く game_id が来るため、`aws:ResourceTag/Game` を condition にしている policy が機能することを再確認 (Phase 5 で `Game=*` の wildcard 化済のはず、`infra/envs/prod/iam.tf` 要確認)。

## 10. 実装ステップ

### 10.0 旧 Phase A (独立した AUTO_CURSEFORGE 検証) を廃止した理由

rev1 では「ATM10 AUTO_CURSEFORGE の end-to-end 検証 (Phase A)」を全 Step のハード前提に置いていたが、rev2 で**独立 Step としては廃止**し、新規追加フロー (D-2/D-3) に畳み込んだ。判断根拠:

1. **Worker/UI 側の実装は EC2 起動の成否と無関係**。CF API client (検索 API を叩くだけ) / magic link 認証 / KV CRUD / SPA は、EC2 が modpack を起動できるかに一切依存しない。B-1〜C-3 は検証ゼロでも安全に作れる。
2. **AUTO_CURSEFORGE は itzg の枯れた標準機能**。自前コードではなく、自前の接ぎ木部分 (`*_FROM_SSM` による SSM secret 注入) は既に Phase 6 (`bf83f57`) でコミット済み。専用検証で新たに得られる情報量は小さい。
3. **検証コストが不釣り合い**。旧 Phase A の保留理由は「既存 ATM10 world snapshot を壊したくない」だった。専用 throwaway 検証は不可逆な snapshot 破棄か追加インフラを要する。
4. **新規追加フローが検証そのものを兼ねる**。Phase 7 の「新規 modpack 追加」は**新 game_id = snapshot なし = 必ず空 EBS から起動**する。つまり ATM10 の snapshot に触れずに AUTO_CURSEFORGE 経路を自然に踏む。元々 Phase A が厄介だった理由が通常フローで消えるため、`atm10-verify` を切る意味がない。

**残す注意点**: 発見タイミングが「初の実 modpack 追加時」に後ろ倒しになる、という認識は持っておく。万一 AUTO_CURSEFORGE が壊れていれば制御されたタイミングではなくそこで判明する。1〜2 人の個人プロジェクトなら許容範囲。`CF_FILE_ID` in-place upgrade 挙動 (§11.2) も同様に UI 経由の初回 upgrade 時に判明し、snapshot があるので復旧可能。

### 10.1 Step 一覧

| Step | 内容 | 推定 | 依存 |
|---|---|---|---|
| **B-1** | CurseForge API client (`lib/curseforge/`) 実装 + 単体テスト | 2h | なし |
| **B-2** | Magic link auth (`lib/auth/admin-session.ts` + `handlers/admin/auth.ts` + `handlers/discord/admin.ts`) | 4h | B-1 |
| **B-3** | `/admin/api/games` (GET 一覧, GET 単体, PUT 更新) + middleware | 3h | B-2 |
| **B-4** | curl で B-1〜B-3 の疎通確認 | 1h | B-3 |
| **C-1** | SPA 雛形 (Vite + Svelte + `/games` 一覧 + ダミーデータで動作) | 3h | B-4 |
| **C-2** | `/games/:id` 編集 UI (env / MEMORY / CF_FILE_ID 書き換え) | 3h | C-1 |
| **C-3** | wrangler.toml `[assets]` binding + 本番 deploy 疎通 | 2h | C-2 |
| **D-1** | `/admin/api/modpacks/search` + `/by-slug/:slug` | 2h | C-3 |
| **D-2** | `/admin/api/games` POST (新規追加) + DNS / S3 / KV 連携 (`register-game.mjs` の主要処理を `lib/registry/build.ts` 経由で Worker 化) | 5h | D-1 |
| **D-3** | SPA: modpack 検索 UI + 新規追加 form。**初回の実追加で AUTO_CURSEFORGE 経路 (空 EBS → modpack DL → 起動) と `CF_FILE_ID` 切替挙動を併せて確認 = 旧 Phase A の代替検証** | 4h | D-2 |
| **E-1** | `lib/orchestrator/start.ts` `stop.ts` 切り出し + Discord handler の refactor | 3h | D-3 |
| **E-2** | `/admin/api/games/:id/{start,stop,status}` + SPA: ops 画面 | 4h | E-1 |
| **F** | `scripts/export-registry.mjs` (KV → Git audit) + 月次運用手順を runbook に追記 | 2h | E-2 |

**Total**: ~38h。MVP (B-1〜C-3 まで = 既存 game の env 編集が WebUI でできる状態) なら ~18h。

## 11. リスク / 未決事項

### 11.1 placeholder-skip-worktree workflow との整合

§8.2 で決める。3 案あり、現時点で B (実値を git commit、placeholder 廃止) を推奨だが、`cf_record_id` 以外に漏れる項目がないか実装前に grep で再確認。

### 11.2 itzg AUTO_CURSEFORGE の挙動未検証

- `CF_FILE_ID` を空 → 既存 install → `CF_FILE_ID=<新>` を渡したとき、in-place upgrade が走るか、それとも old install を消すか
- 公式 docs では「世界データは保持される、mod は cleanup される」だが、実機検証が要る
- → **D-3 の初回新規追加 / 初回 upgrade 時に併せて確認する** (旧 Step A を畳み込んだ先、§10.0)。snapshot があるので万一壊れても復旧可能

### 11.3 CurseForge API の rate limit

未公開。万一 429 を返す挙動なら Worker 側で 60s cache + 指数 backoff が要る。実装は MVP では省略、本番運用で出てから対処。

### 11.4 Workers Static Assets の制約

- ファイル数 20,000 / 合計 25 MB の上限あり (2026-05 時点)
- Svelte build は通常 1 MB 未満なので問題なし
- Vite の `assetsInlineLimit` で小さい画像は inline 化推奨

### 11.5 Cookie domain の問題

`Secure; HttpOnly; SameSite=Strict` で動かすには **`<worker-host>` が HTTPS 必須**。Cloudflare Workers は default で HTTPS だが、`*.workers.dev` だと [[workers-dev-no-zone-waf]] 制約あり。独自ドメイン (例 `gs-admin.<base-domain>`) に CNAME する方が運用上 robust → Phase 7 実装前に独自ドメイン化を決定。

### 11.6 マルチ admin の同時編集競合

`PUT /admin/api/games/:id` で同じ game を 2 人が同時編集すると last-write-wins。MVP では許容 (admin が 1-2 人想定)。将来 ETag (KV の version 取得) で optimistic locking を入れる余地はある。

## 12. 完了基準

### MVP (B-1〜C-3)

- [ ] Discord `/admin` → ephemeral message + button URL が発行される
- [ ] button クリック → SPA `/games` で既存 game 一覧が見える
- [ ] `/games/atm10` 画面で `MEMORY` や `CF_FILE_ID` を編集 → KV に書き込まれる
- [ ] 次回 `/start atm10` (Discord) で更新後の env が反映される

### Full (B-1〜F)

- [ ] WebUI から新規 modpack を検索 → form 入力 → 追加 → `/list` (Discord) に出現
- [ ] その新規 game が空 EBS から AUTO_CURSEFORGE 経路で実機起動する (旧 Phase A の代替検証、§10.0)
- [ ] WebUI から start / stop / status が実行可能
- [ ] `scripts/export-registry.mjs` で KV と Git が一致することが確認できる
- [ ] runbook に Phase 7 運用手順 (admin token 発行、session 失効、新規 game 追加) を追記
