// Worker の environment binding 型定義。
//
// wrangler.toml の [[kv_namespaces]] / [vars] / `wrangler secret put` で投入された値が
// fetch ハンドラの env 引数として渡る。ここで型を一元定義する。

export interface Env {
  // ---- Phase 1 検証用 (Phase 2 で削除予定) ----
  // /admin/* endpoint の Bearer 認証
  ADMIN_API_KEY: string;

  // ---- AWS (IAM Access Key、Phase 5 で OIDC に移行中) ----
  // Phase 5 cutover 完了後 (Step 7) に AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY を削除し
  // AWS_AUTH_MODE を必須 'oidc' に変更する。
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  // optional: 省略時は ap-northeast-1
  AWS_REGION?: string;

  // ---- AWS OIDC (Phase 5) ----
  // 認証モードの段階移行フラグ。未設定または 'static' なら従来の IAM Access Key 経路、
  // 'oidc' なら OIDC token + STS AssumeRoleWithWebIdentity 経路 (lib/aws/credentials.ts)。
  // Step 6 cutover 時に vars で 'oidc' に切替、Step 7 で完全 OIDC 化後は env から削除可。
  AWS_AUTH_MODE?: 'static' | 'oidc';
  // AssumeRoleWithWebIdentity の対象 IAM Role ARN (Step 2 で Terraform 出力した値)。
  // vars 配置で OK (漏れても sub/aud condition で守られる、phase5-plan.md 決定6)。
  // 例: "arn:aws:iam::123456789012:role/gs-worker-oidc-role"
  AWS_OIDC_ROLE_ARN?: string;
  // OIDC JWT に焼く `sub` claim (推測困難な random suffix 付き、phase5-plan.md 決定13)。
  // vars ではなく Workers Secret に置く: `wrangler secret put OIDC_SUB`。
  // trust policy condition で完全一致検証されるため、AWS_OIDC_ROLE_ARN と組み合わせて多層防御。
  OIDC_SUB?: string;
  // OIDC issuer の private key 配列 (JWKS 形式の JSON 文字列)。
  // 形式: `{"keys":[{"kid":"...","kty":"RSA","n":"...","d":"...","e":"AQAB","created_at":1234567890}, ...]}`
  // 配列で持つことで rotation 中の新旧並走 (multi-kid) が可能。最新 created_at の鍵が現用。
  // 投入: `wrangler secret put OIDC_PRIVATE_KEYS_JWK` (生成は scripts/generate-oidc-keypair.mjs)。
  OIDC_PRIVATE_KEYS_JWK?: string;

  // ---- Discord ----
  // Discord Developer Portal の Application → General Information → Public Key (hex)。
  // /discord/interaction の ed25519 検証に必須。
  DISCORD_PUBLIC_KEY: string;
  // Application ID (Developer Portal の General Information → Application ID)。
  // follow-up message API のエンドポイント組み立てに使う (Bot Token は不要、token で十分)。
  DISCORD_APPLICATION_ID: string;

  // ---- Cloudflare DNS ----
  // Zone:DNS:Edit 権限のみの API Token (Phase 1)。Phase 2 で OIDC 検討。
  CLOUDFLARE_DNS_API_TOKEN: string;
  // 対象 zone の ID (Cloudflare dashboard で zone を開いた時の右下に表示)
  CLOUDFLARE_ZONE_ID: string;
  // FQDN 組み立てに使う (例: "example.com"、subdomain="atm11" → atm11.example.com)
  CLOUDFLARE_BASE_DOMAIN: string;

  // ---- EC2 起動パラメータ ----
  // Launch Template ID (Terraform: aws_launch_template.game_server / output launch_template_id)。
  // AMI / Key / SG / IAM profile / Spot 設定 / EBS base / 静的タグは LT 側で定義され、
  // Worker は LT を参照しつつ instance type / user-data / snapshot などゲーム別の値だけ override する。
  EC2_LAUNCH_TEMPLATE_ID: string;
  // インスタンスを起動する subnet。LT には含めず Worker が指定する (default VPC の subnet)。
  EC2_SUBNET_ID: string;

  // ゲーム固有の値 (snapshot seed / DNS record id / RCON SSM パス / launcher tarball) は
  // Phase 2 で registry.json (GAME_REGISTRY KV) に移管済み。env からは持たない。

  // ---- SNS → Discord 集約 (design.md §4.6) ----
  // 受け付ける SNS Topic ARN。allow list として使う。未設定なら全許可 (本番では必須)。
  SNS_ALLOWED_TOPIC_ARN?: string;
  // 通知を投稿する Discord channel webhook URL
  // Discord channel 設定 → Integrations → Webhooks で発行
  DISCORD_WEBHOOK_URL?: string;

  // ---- Sidecar 認証 (Phase 3) ----
  // sidecar (EC2 内) と Worker (`/sidecar/*`) の HMAC-SHA256 共有秘密 (game 別)。
  // JSON map 文字列で投入: `{"atm11":"<base64 secret>","vanilla":"..."}`
  //   投入: wrangler secret put SIDECAR_HMAC_SECRETS
  //   対応 SSM: /gs/<game_id>/sidecar_hmac_secret (sidecar が IMDSv2+SSM で取得する側)
  // 詳細は docs/phase3-plan.md 決定10。
  SIDECAR_HMAC_SECRETS: string;

  // ---- Sidecar 配信 (Phase 3) ----
  // Worker 自身の公開 URL。EC2 user-data に焼いて sidecar の WORKER_URL env として渡す。
  // 例: "https://discord-handler.<account>.workers.dev"。末尾スラッシュは sidecar 側で正規化される。
  // 初回デプロイ後に `pnpm wrangler deploy` の出力から URL を取って wrangler.toml [vars] に書く。
  WORKER_PUBLIC_URL: string;
  // AMI 内に焼き込まれた sidecar image のタグ。省略時 'gs-sidecar:latest'。
  // Phase 7 で Packer が `docker load` するときの tag と一致させる必要がある。
  SIDECAR_IMAGE_REF?: string;

  // ---- KV bindings ----
  // /start 〜 ready 通知の間、interaction の文脈 (token / userId) を一時保存する。
  // Phase 3 から sidecar heartbeat の last_seen / runStopWorkflow の stop-in-progress
  // ロックも同じ namespace に同居するため **必須** binding に格上げ (docs/phase3-plan.md 決定11)。
  // 実体作成: `wrangler kv namespace create SERVER_STATE` → wrangler.toml に id を記載。
  SERVER_STATE: KVNamespace;
  // GAME_REGISTRY: ゲーム定義 (registry.json) の source of truth。
  // key=<game_id> / value=GameDefinition の JSON。register-game.mjs が投入し、Worker は
  // lib/registry/store.ts 経由で読む。SERVER_STATE と違い必須 — これが無いと全コマンドが
  // 機能しないため graceful degradation はしない。
  // 実体作成: `wrangler kv namespace create GAME_REGISTRY` → wrangler.toml に id を記載。
  GAME_REGISTRY: KVNamespace;
}
