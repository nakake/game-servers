# Phase 7 実装計画 — Modpack 管理 WebUI

最終更新: 2026-05-31 (rev5: skip-worktree 撤廃+cf_record_id を KV へ / AWS 委譲は WorkerEntrypoint RPC / 共有 package `@gs/shared` / コマンド `/panel` / ADR 0003・0004 Accepted。rev4: 別 Worker 分離。rev3: opaque token・2 ティア。rev2: 検証 Phase A 廃止)

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
- modpack 検索 / バージョン選択 を **GUI form** で完結
- 既存ゲームの modpack バージョン (`CF_FILE_ID`) を **画面から書き換えて** 次回起動に反映
- 新規 modpack 追加が **registry.json 手書きなし** で完了 (Cloudflare DNS / S3 / KV を Worker 経由で操作)
- start / stop / status を WebUI からも実行可能 (Discord と並列に共存)
- **2 ティア権限** (§1.1): player は modpack 追加・更新・起動操作、admin はそれに加えコスト fields を制御

### 1.1 権限モデル (2 ティア)

5〜8 人の MC プレイヤーが modpack を追加・更新できるが、**コスト/サーバサイズに直結する設定は admin (1〜2 人) だけが触れる**ようにする。

| 操作 / フィールド | player | admin |
|---|---|---|
| modpack 検索 | ✅ | ✅ |
| 新規 modpack 追加 (game_id / display_name / cf_slug / cf_file_id / port) | ✅ | ✅ |
| modpack バージョン更新 (`CF_FILE_ID`) | ✅ | ✅ |
| start / stop / status | ✅ (Discord でも可) | ✅ |
| **instance_types / ebs_size_gb / spot_max_price / MEMORY** (コスト・サイズ系) | ❌ 非表示・既定値で固定 | ✅ 追加時/更新時に設定 |
| ゲーム削除 | ❌ | ❌ (危険操作は Discord/手動) |

- **player の新規追加**: コスト系 fields は UI に出さず、サーバ側の安全な既定値 (§5.3) で固定。player が送ってきても **API 側で無視**
- **enforcement はサーバ側**: UI 非表示は UX。実ガードは Worker の handler で requester の tier を判定し、player のコスト field 書き込みは 403/無視 (§9.1)
- tier 判定: **player allowlist (`PLAYER_DISCORD_USER_IDS`) / admin allowlist (`ADMIN_DISCORD_USER_IDS`) の 2 本の CSV env**。どちらにも無い user は `/auth` で reject (fail-closed)

### 非ゴール

- ゲーム削除 UI (まずは read-only、危険操作は Discord か手動で)
- snapshot / backup の操作 UI (Phase 8 候補)
- コスト / ログ可視化 (Phase 8 候補)
- モバイル最適化 (PC ブラウザ前提、レスポンシブ程度に留める)
- **3 ティア以上の RBAC / role 動的管理** (admin・player の 2 本 CSV allowlist 固定に留める。Discord role 連動は将来余地)

## 2. アーキテクチャ

```
[Discord] (gs-discord-handler 上の /panel command)
   │  /panel
   ▼
[discord-handler Worker]
   │  ① ephemeral response + button URL に one-shot token (KV ADMIN_AUTH に put)
   ▼
[Browser] → https://gs-admin.<base-domain>/auth?t=<token>
   │  ② token 検証 → used=true → opaque session cookie 発行 → / にリダイレクト
   ▼
[SPA] (admin-webui Worker の Static Assets、別 Worker / 別ホスト)
   │  /games           game 一覧
   │  /games/:id       version 編集 (update)
   │  /add             modpack 検索 → 新規追加
   │  /games/:id/ops   start / stop / status
   ▼ fetch (Cookie + X-Requested-With、同一オリジン)
[admin-webui Worker /admin/api/*]
   │  ③ cookie → session 検証 + tier 再導出 (§4)
   │  ④a KV CRUD / CurseForge API / Cloudflare DNS  ← admin-webui が直接
   │  ④b start / stop / status / s3Sync             ← Service Binding RPC で委譲 ↓
   ▼
[discord-handler Worker: WorkerEntrypoint RPC] (HTTP 公開なし、binding 経由のみ)
   │  ⑤ AWS API 呼び出し (既存の OIDC 経路、鍵はここに閉じる)
   ▼
[KV: GAME_REGISTRY / SERVER_STATE / ADMIN_AUTH]  ← 両 Worker が同 namespace を bind
[CurseForge API] [Cloudflare DNS API]            ← admin-webui
[AWS API (OIDC AssumeRole)]                       ← discord-handler のみ
```

### 設計上の特徴

- **2 Worker 構成 (ADR 0004)**: admin WebUI は `workers/admin-webui/` という**別 Worker**に分離し独自ホスト (`gs-admin.<base-domain>`) にデプロイ。discord-handler に SPA を同居させると 8 本の外来ルートが SPA fallback に飲まれる衝突 + AWS 署名鍵 Worker への blast radius が生じるため。Cloudflare Pages は使わない (admin-webui も Workers)
- **AWS 鍵の隔離**: admin-webui は OIDC 秘密鍵を持たない。AWS に触る操作 (start/stop/status/s3Sync) のみ **Service Binding RPC** で discord-handler の `WorkerEntrypoint` メソッドに委譲 (public HTTP 面なし)。KV/CF/DNS は admin-webui が自前 (ADR 0004)
- **Source of truth は Workers KV**: WebUI 操作は KV を直接書く。Git の `games/<id>/registry.json` は audit 用に monthly export スクリプトで反映 (詳細 §8)
- **Discord OAuth 不使用**: magic link 認証で Discord 既存 bot の認証に乗っかる (ADR 0003)。`/panel` command は引き続き discord-handler 上 (token 発行のみ)、それ以外の WebUI は admin-webui

## 3. CurseForge API client

`workers/admin-webui/src/lib/curseforge/` 配下に薄いラッパを置く (ADR 0004 で admin-webui Worker 側に配置)。`x-api-key` ヘッダを `fetch` で渡すだけなので SDK 不要。

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

- **admin-webui Worker 側**: 検索 / メタ取得用。Workers Secret `CF_API_KEY` を **admin-webui に**新規追加 (`wrangler secret put CF_API_KEY` を admin-webui の dir で実行)。discord-handler には入れない (ADR 0004 の責務分割)
- **EC2 側 (既存)**: 既に SSM SecureString `/gs/global/cf_api_key` 経由で `CF_API_KEY_FROM_SSM` ハンドラが処理済

両者で同一の key を使うが secret store は分離 (Workers Secret と SSM の二重保管)。理由: Worker から SSM を読むのは可能だが latency 増 + IAM policy 拡張が要るため、Worker 側は Cloudflare 内に閉じる方がシンプル。rotation 時は **admin-webui の Workers Secret と SSM の 2 箇所**を更新 (runbook に明記)。

## 4. 認証 (magic link)

ADR 0003 で確定した方式。詳細はそちらに譲り、ここでは仕様だけ:

### 4.1 Discord 側

新スラッシュコマンド `/panel` を追加:

- `flags: 64` (EPHEMERAL) で応答 — **必須、テストで担保**。token は bearer なので ephemeral が漏洩対策の要 (§9 / ADR 0003 参照)
- response 本体: `components: [{type:1, components:[{type:2, style:5, label:"管理画面を開く", url:"<ADMIN_BASE_URL>/auth?t=<token>"}]}]`
- token: 32 bytes CSPRNG (`crypto.getRandomValues`) → base64url
- KV `admin_token:<token>` = `{user_id, issued_at, exp_ts, used:false}` **TTL 300s** (URL に乗る token の漏洩窓を縮める。ユーザーは発行直後にクリックするので 5 分で十分)

### 4.2 Browser → Worker

`GET /auth?t=<token>` の処理:

1. KV `admin_token:<token>` を読む
2. `used === false && exp_ts > now` をチェック
3. **`used=true` で put** (race condition は許容、§9 で議論)
4. `user_id` が `ADMIN_DISCORD_USER_IDS` か `PLAYER_DISCORD_USER_IDS` (CSV env) に含まれるか確認し **tier (`admin` | `player`) を決定**。どちらにも無ければ reject (fail-closed)。admin と player 両方に入っている場合は `admin` 優先
5. 32 bytes CSPRNG の opaque session id (`<sid>`) を生成し `gs_admin_session` cookie に発行 (JWT/署名鍵は使わない、理由は ADR 0003)
   - `Secure; HttpOnly; SameSite=Strict; Path=/`
6. KV `admin_session:<sid>` = `{user_id, issued_at, exp_ts}` TTL 86400s (この KV エントリが session の実体 = revoke 可能)。**tier は session に焼き込まず、毎リクエスト allowlist env から再導出する** — CSV parse はコストゼロ同然で、allowlist から外した user / 昇格が次リクエストで即反映される (session に焼くと最大 24h stale になる)
7. HTML を返し、`<script>history.replaceState(null,'','/');location.href='/'</script>` で URL から `?t=` を消す

### 4.3 API リクエスト

- middleware: cookie の `<sid>` → KV `admin_session:<sid>` 存在チェック → **allowlist から tier を再導出** (admin∪player のどちらにも無ければ 401)。解決した tier を後続 handler に渡す
- **コスト系 field の書き込み / admin 専用 endpoint は tier==`admin` を要求** (player は 403)。`withAdminAuth(handler)` に加え `withTier('admin')` のような field/endpoint レベルのガードを置く
- 状態変更 API (PUT/POST/DELETE) は `X-Requested-With: fetch` header を要求 (CORS preflight が立つ仕掛けで CSRF 軽減)

### 4.4 logout

`POST /admin/api/auth/logout`: 現 session の KV `admin_session:<sid>` を delete + cookie clear。

Discord 側にも `/panel logout` を用意し、自分の全 session を失効する経路を持たせる (デバイス紛失対策)。

全 session 失効の実装は **案 b: 全 `admin_session:*` を scan して `user_id` 一致を delete** で確定。理由: WebUI を使えるのは admin+player allowlist の最大 10 人程度 × 数デバイス = KV に溜まる session は数十エントリ止まり (TTL 24h で自然消滅) なので、`list + filter` のコストは無視できる。`user_sessions:<user_id>` の二次 index や毎リクエストの世代カウンタ照合は、この規模では over-engineering。将来 admin が数百人規模になることは構造上ないため index 化は不要。

## 5. データモデル

### 5.1 KV namespace の追加・流用

| Namespace | 用途 | Phase 7 で新規? |
|---|---|---|
| Namespace | 用途 | Phase 7 で新規? | bind 先 |
|---|---|---|---|
| `GAME_REGISTRY` (既存) | game_id → registry.json | 流用 | 両 Worker |
| `SERVER_STATE` (既存) | 起動状態 / pending_ready / notif_suppress | 流用 | 両 Worker (discord-handler は AWS 委譲時に参照) |
| `ADMIN_AUTH` (新) | `admin_token:*` / `admin_session:*` | **新規** | 両 Worker (`/panel` token 発行は discord-handler、検証は admin-webui) |

`SERVER_STATE` に相乗りも可能だが、key prefix 衝突と TTL の独立性のため `ADMIN_AUTH` を別 namespace で作る。**同じ namespace id を両 Worker の `wrangler.toml` に bind する** (KV namespace は複数 Worker から共有可能)。`admin_token:*` は discord-handler の `/panel` command が put し admin-webui の `/auth` が読む、`admin_session:*` は admin-webui のみが扱う。

### 5.2 KV key 設計

| Key | Value | TTL |
|---|---|---|
| `admin_token:<token>` | `{user_id, issued_at, exp_ts, used:bool}` | 300s |
| `admin_session:<sid>` | `{user_id, issued_at, exp_ts}` | 86400s |
| `game:<game_id>` (既存 GAME_REGISTRY) | GameDefinition JSON | 無制限 |

### 5.3 GameDefinition の拡張

新規 game を Web から追加する場合、`registry.json` を生成するために以下フィールドが UI 入力対象になる。**フィールドは tier で 2 群に分かれる** (§1.1):

```typescript
// player / admin 共通で入力可
interface NewGameFormPlayer {
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
  port: number;             // 既定: 25565
}

// admin のみ入力可。player の追加時は UI に出さず下記 DEFAULT を強制
interface NewGameFormAdmin extends NewGameFormPlayer {
  memory_gb: number;        // 例: 10
  instance_types: string[]; // 既定: ["r7a.large", "r6a.large"]
  ebs_size_gb: number;      // 既定: 30
  spot_max_price_jpy_per_hour: number | null;
}

// player 追加 / admin が省略した場合に使うサーバ側既定 (lib/registry/build.ts に定数で持つ)
const COST_FIELD_DEFAULTS = {
  memory_gb: 8,
  instance_types: ["r7a.large", "r6a.large"],
  ebs_size_gb: 30,
  spot_max_price_jpy_per_hour: null,
};
```

**サーバ側 enforcement**: `POST /admin/api/games` handler は requester の tier を見て、`tier==='player'` なら body のコスト系 fields を **無視して `COST_FIELD_DEFAULTS` を適用**する (送られてきても採用しない)。`tier==='admin'` のみ値を採用。`build.ts` の変換関数は `(form, tier)` を受け、tier に応じてコスト fields を確定する。

`NewGameForm*` → `GameDefinition` 変換 (`build.ts`) と関連型は **共有 package `@gs/shared`** に置く (A-3、§7.2)。admin-webui の handler と `scripts/register-game.mjs` の両方から import する。

## 6. API 仕様

すべて `/admin/api/` 配下、Cookie 認証必須。**tier** 列は最低要求権限 (player は admin より狭い)。

| Method | Path | 用途 | tier | 副作用 |
|---|---|---|---|---|
| `GET` | `/admin/api/games` | game 一覧 (KV scan) | player | なし |
| `GET` | `/admin/api/games/:id` | 単体取得 | player | なし |
| `PUT` | `/admin/api/games/:id` | 更新。**コスト系 fields (instance_types / ebs_size_gb / spot_max_price / MEMORY) は admin のみ採用、player は無視**。`CF_FILE_ID`/version 等の非コスト fields は player も可 | player (コスト fields は admin) | KV write |
| `POST` | `/admin/api/games` | 新規追加。player はコスト fields を `COST_FIELD_DEFAULTS` で固定 (§5.3) | player | CF DNS A 作成 + S3 prefix 作成 + KV put |
| `POST` | `/admin/api/games/:id/start` | 起動 | player | **Service Binding RPC** `env.DISCORD_HANDLER.start(id)` (AWS) |
| `POST` | `/admin/api/games/:id/stop` | 停止 | player | **Service Binding RPC** `env.DISCORD_HANDLER.stop(id)` (AWS) |
| `GET` | `/admin/api/games/:id/status` | 状態取得 | player | **Service Binding RPC** `env.DISCORD_HANDLER.status(id)` (EC2 describe) + KV state read |
| `GET` | `/admin/api/modpacks/search?q=` | CF API search proxy | player | CF API 1 call (admin-webui 直) |
| `GET` | `/admin/api/modpacks/by-slug/:slug` | slug → 詳細 + バージョン一覧 | player | CF API 2 call (admin-webui 直) |
| `POST` | `/admin/api/auth/logout` | session 失効 | player | KV delete (admin-webui 直) |

### 6.1 AWS 操作の委譲 (Service Binding) と重複排除

AWS に触る操作 (start/stop/status/s3Sync) は **admin-webui には置かず、discord-handler の WorkerEntrypoint RPC メソッドに Service Binding 経由で委譲**する (ADR 0004、鍵の隔離)。orchestrator core は **discord-handler 内に閉じたまま**、Discord interaction と RPC メソッドの両方から呼べるように切り出す:

```
discord-handler Worker
  handlers/discord/start.ts    ── Discord 用 wrapper (3秒応答 + followUp)
  internal-rpc.ts              ── export class InternalRpc extends WorkerEntrypoint {
                                     async start(id) / stop(id) / status(id) / s3Sync(...) }
        ↓                              ↓
        └─── lib/orchestrator/start.ts (game, ctx, env, progressCallback) ───┘

admin-webui Worker
  handlers/admin/games.ts      ── await env.DISCORD_HANDLER.start(id) を呼ぶだけ
```

- **RPC は public HTTP 面を作らない**: `WorkerEntrypoint` のメソッドは Service Binding 経由でしか呼べず、外部 URL から到達しない。共有 secret / header 検証は不要 (A-2 決定)。`this.env` / `this.ctx` から既存の orchestrator (`ctx, env` を取る) をそのまま呼べる
- **進捗通知**: Discord 側は `followUp.editOriginal`、Web 側は **polling で `/admin/api/games/:id/status`** (これも `env.DISCORD_HANDLER.status(id)` RPC で引く)。SSE は MVP では使わない
- orchestrator (OIDC 鍵を使う実装) は共有 package に出さず discord-handler 内に置く。admin-webui が `@gs/shared` から import するのは **型 + zod + pure 変換のみ** (RPC の引数/戻り値型もここ。AWS ロジックは入れない、A-3)

## 7. SPA 構成

### 7.1 技術スタック

- **Framework**: Svelte 4 (SvelteKit ではなく Svelte + Vite 単体、static export 前提)
- **Build**: Vite → 出力 `workers/admin-webui/public/`
- **CSS**: Tailwind CSS (or 単純な custom CSS でも可、要件次第)
- **Forms**: 検証は zod (admin-webui Worker 側と共有可能)

Svelte 採用理由: React/Vue より bundle size が小さく、SPA が ~30-50KB に収まる。Workers Static Assets は Cloudflare CDN から配信されるため重さは致命的ではないが、ロード速度はユーザー体感に直結。

### 7.2 ファイル配置

```
packages/shared/                 # ★ 新 workspace package (A-3、両 Worker + script が依存)
├─ registry-types.ts             # GameDefinition / NewGameForm{Player,Admin} / COST_FIELD_DEFAULTS
├─ rpc-types.ts                  # InternalRpc の引数・戻り値型 (StartResult / StatusResult 等)
├─ build.ts                      # NewGameForm → GameDefinition 変換 ((form, tier) を取る pure 関数)
└─ package.json                  # name: @gs/shared
  # 注: AWS / OIDC ロジックは入れない (鍵隔離、ADR 0004)。型 + zod + pure 変換のみ

workers/admin-webui/             # ★ 新 Worker (ADR 0004)
├─ public/                       # ← Vite build 出力 (gitignore)
├─ wrangler.toml                 # [assets] + KV + service binding
└─ src/
    ├─ index.ts                  # /auth, /admin/api/* を route、それ以外を ASSETS.fetch
    ├─ handlers/
    │   ├─ auth.ts               # /auth, /admin/api/auth/logout
    │   ├─ games.ts              # /admin/api/games/* (build は @gs/shared、AWS は DISCORD_HANDLER RPC)
    │   └─ modpacks.ts           # /admin/api/modpacks/*
    └─ lib/
        ├─ curseforge/           # 新規 (client.ts / types.ts)
        └─ auth/
            └─ admin-session.ts  # 新規 (session token issue/verify, allowlist, tier。署名鍵なし)

workers/discord-handler/         # 既存。Phase 7 で追加するのは下記のみ
└─ src/
    ├─ internal-rpc.ts           # 新規。export class InternalRpc extends WorkerEntrypoint
    │                            #   { start(id) / stop(id) / status(id) / s3Sync(...) } ← binding 経由のみ
    ├─ handlers/
    │   └─ discord/
    │       └─ panel.ts          # 新スラッシュコマンド /panel (token 発行 + ephemeral button)
    └─ lib/
        ├─ registry/types.ts     # 既存の GameDefinition 等を @gs/shared へ移し、ここは re-export に
        └─ orchestrator/         # 新規 (start/stop の core ロジック切り出し)
            ├─ start.ts
            └─ stop.ts

admin-ui/                        # SPA source (build 先は workers/admin-webui/public/)
├─ src/{App.svelte, routes/{Games,GameDetail,AddGame,GameOps}.svelte, lib/api.ts}
├─ package.json
└─ vite.config.ts
```

`admin-ui/` を build すると `workers/admin-webui/public/` に出力されるよう Vite を設定。**CI が無いため** (§11.7)、admin-webui の `wrangler.toml` に `[build] command = "pnpm --filter admin-ui build"` を入れて deploy 時に必ず build が走るよう結合する (空の `public/` を deploy する事故防止)。

### 7.3 admin-webui の wrangler.toml

admin-webui には外来ルートが無いので、**`not_found_handling = "single-page-application"` を素直に使える** (ADR 0004 — discord-handler 同居時のような `run_worker_first` の小細工は不要):

```toml
name = "gs-admin-webui"
main = "src/index.ts"
# routes で独自ドメインに割り当て (§11.5)
routes = [{ pattern = "gs-admin.<base-domain>", custom_domain = true }]

[assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "single-page-application"   # 衝突なし

[build]
command = "pnpm --filter admin-ui build"

# KV (discord-handler と同じ namespace id を共有)
[[kv_namespaces]]
binding = "GAME_REGISTRY"
id = "..."
[[kv_namespaces]]
binding = "SERVER_STATE"
id = "..."
[[kv_namespaces]]
binding = "ADMIN_AUTH"
id = "..."

# AWS 操作を委譲する Service Binding (RPC: WorkerEntrypoint を指定)
[[services]]
binding = "DISCORD_HANDLER"
service = "gs-discord-handler"
entrypoint = "InternalRpc"        # ← discord-handler が export する RPC class
```

`src/index.ts` は `/admin/api/*` と `/auth` を自前 handler に、それ以外を `env.ASSETS.fetch(request)` にディスパッチ。SPA fallback は platform 任せ。

discord-handler 側 `wrangler.toml` には `ADMIN_AUTH` の bind 追加 (`/panel` token 発行用) のみ。AWS 委譲は `InternalRpc` (WorkerEntrypoint) を `export` するだけで HTTP route は増えない。`[assets]` は **付けない** (SPA を持たない)。

## 8. Source of truth (KV 真、Git は audit 用)

### 8.1 基本方針

- **WebUI 操作は KV を直接書く**
- **Git の `games/<id>/registry.json` は audit / 災害復旧用**
- 既存 `scripts/register-game.mjs` は **Git → KV** 方向 (新規 game の初期投入や災害復旧時のみ) として残す
- 新規 `scripts/export-registry.mjs` で **KV → Git** 方向 (monthly run、`git diff` で audit) を作る

### 8.2 placeholder-skip-worktree の撤廃 (決定: Option B+)

`games/<id>/registry.json` は現在 [[placeholder-skip-worktree-workflow]] パターン (HEAD には placeholder、ローカルに実値、`git update-index --skip-worktree` で git から隠す) を採用している。これは export script (KV→Git) と相性が悪い (skip-worktree を一時解除する dance が要る) ため Phase 7 で撤廃する。

**調査結果**: HEAD の committed registry.json で placeholder 化されている field は **`cf_record_id` ただ 1 つ**。subdomain / config_s3_prefix (bucket 名) / SSM パス / instance_types / env は**すべて既に実値で公開済み**。つまり registry.json の機密性 surface は `cf_record_id` のみ。そして `cf_record_id` は **Cloudflare が A レコード作成時に返す runtime 割当 ID** (起動毎の DNS 更新に使う handle) であり、source config ではなく **runtime state**。

**決定 (Option B+)**:
1. **`cf_record_id` を registry.json から KV (`SERVER_STATE`) へ移す**。register-game.mjs / WebUI 新規追加がレコード作成時に受け取った id を KV に書き、DNS 更新ロジックは KV から読む
2. これで registry.json に機密 field が **ゼロ** になる → **実値で commit、skip-worktree を撤廃**
3. 撤廃は 1 度のクリーンアップ commit (`git update-index --no-skip-worktree games/*/registry.json` → 実値 commit)。infra/wrangler の 5 ファイルは Phase 7 と無関係なので skip-worktree 据え置き

**効果**: export script の `--no-skip-worktree` dance が不要 / `cf_record_id` は公開されない (Phase 5 の「infra id を public Git に出さない」posture を維持) / 「KV=真、Git=audit」と一致。

> 実装時の確認: `cf_record_id` を読む既存コード経路 (DNS 更新) を KV 参照に寄せる。export script は cf_record_id を Git に書かない (スキーマから外れるので自然に除外)。

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
| 1 | `/panel` 応答に EPHEMERAL flag を忘れる (**load-bearing**: token は bearer で allowlist は漏洩を止めない → チャンネル全員が 5 分以内にクリックすれば発行者として入れる) | unit test で `flags: 64` を assert (最重要) |
| 1b | token 漏洩一般 (履歴 / proxy / 肩越し) | one-shot + TTL 300s + `history.replaceState` + link button UI。allowlist では止まらない前提で多層化 |
| 2 | allowlist env (`ADMIN_*` / `PLAYER_*`) の空文字列・typo で fail-open | どちらにも無い user は `/auth` で reject (fail-closed)。`ADMIN_DISCORD_USER_IDS` は最低 1 件を init で assert (player list は空でも可 = admin 専用運用) |
| 2b | **player が API を直接叩いてコスト fields を書き換える** (UI 非表示は迂回可能) | サーバ側で tier を判定し、player の instance_types/ebs/spot/MEMORY 書き込みは無視 or 403。**UI 非表示に依存しない** (§1.1 / §5.3 / §6) |
| 3 | admin endpoint / field で auth・tier check 漏れ | `withAdminAuth(handler)` + コスト系は `withTier('admin')` を bolt-on。tier はテストで player→403 を assert |
| 4 | URL の token がブラウザ履歴に残る | `/auth` HTML で `history.replaceState` を即実行 |
| 5 | XSS による cookie 自動付与攻撃 | CSP `script-src 'self'` + 状態変更 API は `X-Requested-With` header 要求 |
| 6 | wrangler tail で `?t=xxx` が見える | `/auth` handler 内で token を log redact |
| 7 | KV の 1-shot 保証が race condition で破れる | KV は eventually-consistent。実害「同一ユーザーの 2 セッション」のみで軽微、許容 |
| 8 | session 24h が長すぎてデバイス紛失時に被害 | `/panel logout` (Discord 経由) で全 session revoke 可能に (sid 列挙の仕組みは §4.4 で要設計) |

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
| **B-0a** | `packages/shared/` (`@gs/shared`) を切り、discord-handler の `GameDefinition` 等の型を移植 (元は re-export に) + pnpm-workspace.yaml に `packages/*` 追加。registry-types / rpc-types / build.ts の骨組み | 2h | なし |
| **B-0b** | `workers/admin-webui/` scaffold (wrangler.toml: assets + KV bind + DISCORD_HANDLER service binding entrypoint)、独自ドメイン `gs-admin.<base-domain>` 割当、空 deploy 疎通 | 2h | B-0a |
| **B-1** | CurseForge API client (`admin-webui/src/lib/curseforge/`) 実装 + 単体テスト | 2h | B-0b |
| **B-2** | Magic link auth: `admin-webui` の `lib/auth/admin-session.ts` + `handlers/auth.ts` (session/tier) と、discord-handler の `handlers/discord/panel.ts` (token 発行 + ephemeral button、ADMIN_AUTH bind) | 4h | B-0b |
| **B-3** | `/admin/api/games` (GET 一覧, GET 単体, PUT 更新) + auth/tier middleware | 3h | B-2 |
| **B-4** | curl で B-1〜B-3 の疎通確認 (cookie / tier 403 含む) | 1h | B-3 |
| **C-1** | SPA 雛形 (Vite + Svelte + `/games` 一覧 + ダミーデータで動作) | 3h | B-4 |
| **C-2** | `/games/:id` 編集 UI (CF_FILE_ID/version。コスト fields は admin のみ表示) | 3h | C-1 |
| **C-3** | admin-webui の `[assets]` deploy 疎通 (SPA + API が同一オリジンで動く) | 2h | C-2 |
| **D-1** | `/admin/api/modpacks/search` + `/by-slug/:slug` | 2h | C-3 |
| **D-2** | `/admin/api/games` POST (新規追加) + DNS (admin-webui 直) / KV / **S3 sync は Service Binding RPC** (`register-game.mjs` の主要処理を `@gs/shared` の `build.ts` に移植、`(form, tier)` 対応) | 5h | D-1 |
| **D-3** | SPA: modpack 検索 UI + 新規追加 form。**初回の実追加で AUTO_CURSEFORGE 経路 (空 EBS → modpack DL → 起動) と `CF_FILE_ID` 切替挙動を併せて確認 = 旧 Phase A の代替検証** | 4h | D-2 |
| **E-1** | discord-handler: `lib/orchestrator/start.ts` `stop.ts` 切り出し + `internal-rpc.ts` (`InternalRpc extends WorkerEntrypoint`、start/stop/status/s3Sync) + Discord handler の refactor | 4h | D-3 |
| **E-2** | admin-webui `/admin/api/games/:id/{start,stop,status}` (`env.DISCORD_HANDLER.*` RPC を呼ぶ) + SPA: ops 画面 | 4h | E-1 |
| **F** | `scripts/export-registry.mjs` (KV → Git audit) + 月次運用手順を runbook に追記 | 2h | E-2 |

**Total**: ~43h。MVP (B-0a〜C-3 まで = 既存 game の version 編集が WebUI でできる状態) なら ~22h。

> 分離 (ADR 0004) + 共有 package (A-3) による増分: B-0a (shared package +2h) / B-0b (Worker scaffold +2h) / E-1 の RPC メソッド化 (+1h)。代わりに `run_worker_first` ディスパッチの実装・テスト・本番事故リスク + 型 drift が消える。

## 11. リスク / 未決事項

### 11.1 placeholder-skip-worktree workflow との整合 (決定済)

§8.2 で **Option B+ に確定**: `cf_record_id` を KV (SERVER_STATE) へ移して registry.json を機密フリーにし、skip-worktree を撤廃して実値 commit。漏れ field 調査も完了 (placeholder は cf_record_id のみだった)。infra/wrangler の skip-worktree 5 ファイルは対象外。

### 11.2 itzg AUTO_CURSEFORGE の挙動未検証

- `CF_FILE_ID` を空 → 既存 install → `CF_FILE_ID=<新>` を渡したとき、in-place upgrade が走るか、それとも old install を消すか
- 公式 docs では「世界データは保持される、mod は cleanup される」だが、実機検証が要る
- → **D-3 の初回新規追加 / 初回 upgrade 時に併せて確認する** (旧 Step A を畳み込んだ先、§10.0)。snapshot があるので万一壊れても復旧可能

### 11.3 CurseForge API の rate limit

未公開。万一 429 を返す挙動なら Worker 側で 60s cache + 指数 backoff が要る。実装は MVP では省略、本番運用で出てから対処。

### 11.4 Workers Static Assets の制約 / ルーティング

- ファイル数 20,000 / 合計 25 MB の上限あり (2026-05 時点)。Svelte build は通常 1 MB 未満なので問題なし
- Vite の `assetsInlineLimit` で小さい画像は inline 化推奨
- **ルーティング衝突は ADR 0004 (別 Worker 分離) で解消済**。admin-webui には外来ルートが無いので `not_found_handling=SPA` を素直に使え、`run_worker_first` の手当ては不要

### 11.5 独自ドメイン (分離で事実上確定)

ADR 0004 で admin-webui を別 Worker にしたため、**独自ドメイン `gs-admin.<base-domain>` への割当が前提**になった (B-0)。理由は 3 つ:
- `Secure; HttpOnly; SameSite=Strict` cookie は HTTPS 必須 (workers.dev でも HTTPS だが下記 WAF 制約あり)
- `*.workers.dev` には zone WAF / rate limit が効かない ([[workers-dev-no-zone-waf]])
- SPA と API を同一オリジンに揃える (cookie の取り回し)

### 11.6 マルチ admin の同時編集競合

`PUT /admin/api/games/:id` で同じ game を 2 人が同時編集すると last-write-wins。MVP では許容 (admin が 1-2 人想定)。将来 ETag (KV の version 取得) で optimistic locking を入れる余地はある。

### 11.7 CI 不在 → build を deploy に結合

`.github/workflows/` に CI は無く deploy は手動 `wrangler deploy`。SPA は `admin-ui/` を build して `workers/admin-webui/public/` に出力する 2 段構成なので、**build 忘れで空/古い `public/` を deploy する事故**が起きうる。対策: admin-webui の `wrangler.toml` に `[build] command = "pnpm --filter admin-ui build"` を入れ、`wrangler deploy` が必ず build を先に走らせるよう結合する (§7.3)。

## 12. 完了基準

### MVP (B-1〜C-3)

- [ ] Discord `/panel` → ephemeral message + button URL が発行される
- [ ] button クリック → SPA `/games` で既存 game 一覧が見える
- [ ] `/games/atm10` 画面で `MEMORY` や `CF_FILE_ID` を編集 → KV に書き込まれる
- [ ] 次回 `/start atm10` (Discord) で更新後の env が反映される

### Full (B-1〜F)

- [ ] WebUI から新規 modpack を検索 → form 入力 → 追加 → `/list` (Discord) に出現
- [ ] その新規 game が空 EBS から AUTO_CURSEFORGE 経路で実機起動する (旧 Phase A の代替検証、§10.0)
- [ ] WebUI から start / stop / status が実行可能
- [ ] `scripts/export-registry.mjs` で KV と Git が一致することが確認できる
- [ ] runbook に Phase 7 運用手順 (admin token 発行、session 失効、新規 game 追加) を追記
