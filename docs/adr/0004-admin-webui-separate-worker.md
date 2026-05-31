# ADR 0004: 管理 WebUI を discord-handler とは別の Worker に分離する

- **Status**: Accepted
- **Date**: 2026-05-31
- **Deciders**: nakake
- **Related**: [phase7-modpack-webui.md](../phase7-modpack-webui.md) §2 / [adr/0003-magic-link-auth.md](0003-magic-link-auth.md) / [design.md](../design.md) §4 (Worker 構成)

## Context

phase7-modpack-webui.md の初版 (rev1) は admin WebUI (SPA + admin API + 認証) を **既存 `workers/discord-handler/` に同居** させる設計だった (§2「単一 Worker」)。理由は「Cloudflare Pages を別途立てない / 既存資産に直 import」のシンプルさ。

しかし設計を詰める過程で 2 つの問題が表面化した:

### 問題 1: Static Assets のルーティング衝突

discord-handler は既に **8 本の外来ルート** (`/discord/interaction`, `/aws/notification`, `/sidecar/*`, `/admin/docker-stop`, `/oidc/.well-known/*`, `/ping`, `/health`) を持つ。ここに SPA を同居させて `not_found_handling = "single-page-application"` を入れると、**静的ファイルにマッチしない全パスが index.html に飲まれる**。assets-first がデフォルトなので、`/discord/interaction` も `/sidecar/*` も `/oidc/*` も Worker に到達しなくなり、**Discord bot・sidecar・OIDC issuer が全滅する**。

回避には `run_worker_first = true` + 末尾フォールバックの手当てが要るが、これは「同居しているから生じる」問題であり、本質的な複雑性の持ち込みである。

### 問題 2: AWS 署名鍵 Worker への blast radius

discord-handler は **`OIDC_PRIVATE_KEYS_JWK` (= AWS への AssumeRole 署名鍵) を保持する Worker**。Phase 5 でわざわざ least-privilege 化した、このシステムで最も守るべき Worker。そこへ admin web app + サードパーティ CurseForge API client + 認証フローを同居させると、**AWS 署名鍵を持つ Worker の攻撃面・障害面が web app の分だけ膨らむ**。Discord interaction の 3 秒応答制約も、同居コードのバグや bundle 肥大の影響を受けうる。

## Decision

**admin WebUI を `workers/admin-webui/` という別 Worker に分離し、独自ホスト (例 `gs-admin.<base-domain>`) にデプロイする。AWS に触る操作は Service Binding 経由で discord-handler に委譲する。**

### 責務分割

```
workers/admin-webui/   ── 新 Worker (gs-admin.<base-domain>)
  - SPA assets (Workers Static Assets, not_found_handling=SPA)
  - /auth, /admin/api/* (認証 + 認可 middleware)
  - KV CRUD (GAME_REGISTRY / SERVER_STATE / ADMIN_AUTH を直接 bind)
  - CurseForge API 呼び出し (検索・メタ取得)
  - Cloudflare DNS API 呼び出し (新規 game の A レコード作成)
  - AWS 操作は持たない → Service Binding で discord-handler に委譲

workers/discord-handler/   ── 既存、ほぼ無改修
  - Discord / sidecar / OIDC / AWS (OIDC 秘密鍵はここに閉じたまま)
  - WorkerEntrypoint RPC class を追加 (HTTP route ではない):
      start / stop / status / s3Sync メソッド (= AWS に触る操作のみ)
```

### 設計上のポイント

- **同一オリジン**: SPA と `/admin/api/*` は同じ admin-webui Worker に置く。session cookie が同一オリジンで完結し、CORS 問題が出ない
- **AWS 鍵の隔離**: admin-webui は `OIDC_PRIVATE_KEYS_JWK` を**持たない**。AWS に触る操作 (start/stop/status/s3Sync) は Service Binding **RPC** (`env.DISCORD_HANDLER.start(gameId)` 等) で discord-handler に委譲。鍵は引き続き discord-handler 1 箇所のみ
- **RPC は public HTTP 面を作らない**: discord-handler に `WorkerEntrypoint` class を生やしメソッドを公開する。これは Service Binding 経由でしか呼べず、HTTP route として外部到達しない。同一 colo の Worker 間 RPC でホップなし・無料。**共有 secret も不要** (public endpoint を生やさないので守る対象がない)
- **KV namespace は共有**: 同じ namespace id を両 Worker に bind。GAME_REGISTRY / SERVER_STATE は両者から読める
- **secrets は責務で分割**: admin-webui = CF_API_KEY + Cloudflare DNS token / discord-handler = OIDC 鍵 (従来通り)。鍵の二重保管は発生しない

## Consequences

### Positive

1. **ルーティング衝突が構造的に消える**: admin-webui には飲み込む対象の外来ルートが無いので `not_found_handling=SPA` を素直に使える。`run_worker_first` の小細工不要
2. **AWS 署名鍵 Worker を最小に保てる**: discord-handler に web app を載せない。攻撃面・障害面が増えない。Phase 5 の「鍵を持つ経路は最小に」と一貫
3. **blast radius 隔離**: admin app のバグ/脆弱性/bundle 肥大が Discord 3 秒応答・OIDC issuer に波及しない
4. **デプロイ独立**: SPA の小修正で鍵 Worker を再デプロイしない。admin-webui だけ deploy できる
5. **同一オリジン cookie**: SPA と API が同 Worker なので認証 cookie の取り回しが単純

### Negative / Trade-off

| トレードオフ | 評価 / 緩和 |
|---|---|
| デプロイ単位が 2 つに増える | 同じ wrangler ツールチェーン内。Cloudflare Pages のような別製品ではない。CI/手動 deploy の step が 1 個増えるのみ |
| Service Binding の indirection | 同一 colo RPC でホップなし・無料。orchestrator を「共有 lib」ではなく「WorkerEntrypoint RPC メソッド」として実装する形になるが手間はほぼ同じ (E-1) |
| 共有コード (registry types / build.ts) の置き場 | monorepo の workspace package か、admin-webui に置いて script から import。AWS ロジックは discord-handler 側に残すので共有対象は型と変換関数程度 |
| 独自ドメインが事実上必須 | cookie / WAF の観点でいずれ要る ([[workers-dev-no-zone-waf]])。分離で前倒しになるだけ |
| 内部呼び出しの保護 | WorkerEntrypoint RPC を使うので **public HTTP route を生やさない** = 外部から到達不可。header 検証や共有 secret は不要 |

### 「単一 Worker」決定の撤回

§2 rev1 の「単一 Worker / Cloudflare Pages を立てない」のうち、**「Cloudflare Pages を立てない」は維持** (admin-webui も Workers であり Pages ではない)、**「単一 Worker」は撤回** する。動機だったシンプルさは、ルーティング衝突と鍵 blast radius のコストに見合わないと判断した。

## Alternatives Considered

### 案 X: discord-handler に同居 (rev1 の設計)

`run_worker_first = true` + 末尾を `env.ASSETS.fetch` にフォールバックすれば動作はする。

- **Pros**: デプロイ 1 単位、共有コードを直 import、service binding 不要
- **Cons (不採用理由)**: 上記 Context の問題 1・2 がそのまま残る。特に AWS 署名鍵を持つ Worker に web app を同居させる security 上の不利は、シンプルさの利得を上回ると判断

### 案: Cloudflare Pages で SPA を配信

- **Cons**: 別製品・別ビルド系が増える。API は別 Worker に置くことになり、SPA↔API が cross-origin 化して cookie が面倒。phase7 の元方針 (Pages を立てない) とも反する

### 案: admin-webui に AWS 認証情報を複製

Service Binding を使わず admin-webui が直接 AWS を叩く。

- **Cons (不採用理由)**: `OIDC_PRIVATE_KEYS_JWK` を 2 つ目の Worker に複製することになり、**鍵の隔離という本分離の目的を自壊させる**。Service Binding 委譲なら鍵は 1 箇所のまま

## References

- [Cloudflare Workers — Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Cloudflare Workers — Static Assets routing / not_found_handling](https://developers.cloudflare.com/workers/static-assets/routing/)
- [phase7-modpack-webui.md](../phase7-modpack-webui.md) §2 / §6 / §7
- [adr/0003-magic-link-auth.md](0003-magic-link-auth.md) — 認証方式 (本 ADR と独立、admin-webui 上で動く)
