// admin-webui Worker の environment binding 型定義 (Phase 7、ADR 0004)。
//
// wrangler.toml の [[kv_namespaces]] / [assets] / [[services]] と、
// `wrangler secret put` / `.dev.vars` で投入された値が fetch ハンドラの env に渡る。
//
// 設計上の制約 (ADR 0004): admin-webui は **AWS / OIDC 秘密鍵を持たない**。
// AWS に触る操作 (start/stop/status) は DISCORD_HANDLER への Service Binding RPC
// に委譲する。CurseForge / Cloudflare DNS / KV は admin-webui が自前で扱う。

import type { InternalRpcInterface } from "@gs/shared/rpc-types";

export interface Env {
  // ---- KV bindings (discord-handler と同じ namespace を共有) ----
  // ゲーム定義 (registry.json) の source of truth。key=<game_id> / value=GameDefinition JSON。
  GAME_REGISTRY: KVNamespace;
  // 起動状態 / pending_ready / notif_suppress。Phase 7 では cf_record_id もここへ移す (docs §8.2)。
  SERVER_STATE: KVNamespace;
  // magic link の one-shot token (`admin_token:*`) と session (`admin_session:*`)。
  // token は discord-handler の /panel が put、検証と session は admin-webui が扱う (docs §5.1)。
  ADMIN_AUTH: KVNamespace;

  // ---- Static Assets (SPA) ----
  // Vite build 出力 (./public) を配信する binding。/auth と /admin/api/* 以外は
  // index.ts が env.ASSETS.fetch(request) に委譲し、SPA fallback は platform 任せ (docs §7.3)。
  ASSETS: Fetcher;

  // ---- Secrets (`wrangler secret put` / .dev.vars) ----
  // CurseForge API key。検索 / メタ取得用 (`x-api-key` header)。EC2 側は SSM 経由で別管理 (docs §3.2)。
  CF_API_KEY: string;
  // 管理者の Discord user_id の CSV。tier=admin (コスト系 field / admin 専用操作)。
  // 最低 1 件を init で assert (docs §9.1 #2)。実在の人物を特定しうるため Secret 扱い。
  ADMIN_DISCORD_USER_IDS: string;
  // プレイヤーの Discord user_id の CSV。tier=player (modpack 追加/更新/start/stop)。
  // admin 専用運用なら空でも可。同上 Secret 扱い。
  PLAYER_DISCORD_USER_IDS?: string;

  // ---- Cloudflare DNS (admin-webui 直、ADR 0004 / D-2) ----
  // 新規ゲーム追加 (POST /admin/api/games) で <subdomain>.<base> の A レコードを作る。
  // Zone:DNS:Edit 権限の API Token。discord-handler と同一 token を別 secret store に持つ
  // (鍵隔離の対象は AWS/OIDC のみで、Cloudflare DNS は admin-webui の責務)。Secret 扱い。
  CLOUDFLARE_DNS_API_TOKEN: string;
  // DNS レコードを作る zone と base domain。非機密だが wrangler.toml [vars] で投入する。
  CLOUDFLARE_ZONE_ID: string;
  CLOUDFLARE_BASE_DOMAIN: string;

  // ---- Service Binding (RPC、E-1/E-2 で有効化) ----
  // discord-handler が export する InternalRpc (WorkerEntrypoint) への binding。
  // AWS 操作 (start/stop/status) を OIDC 鍵を複製せず委譲する (docs §6.1)。E-1 で
  // InternalRpc を実装したので E-2 で有効化。wrangler.toml の [[services]] も併せて解除する。
  // 型は契約 interface を直接当てる: RPC stub の各メソッドは Promise<契約型> を返すので
  // `Service<>` ラッパは不要 (Service<> は WorkerEntrypoint-branded 型しか受けない)。
  DISCORD_HANDLER: InternalRpcInterface;
}
