// Worker の environment binding 型定義。
//
// wrangler.toml の [[kv_namespaces]] / [vars] / `wrangler secret put` で投入された値が
// fetch ハンドラの env 引数として渡る。ここで型を一元定義する。

export interface Env {
  // ---- Phase 1 検証用 (Phase 2 で削除予定) ----
  // /admin/* endpoint の Bearer 認証
  ADMIN_API_KEY: string;

  // ---- AWS (IAM Access Key, Phase 2 で OIDC に移行) ----
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  // optional: 省略時は ap-northeast-1
  AWS_REGION?: string;

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

  // ---- ATM11 固有 (Phase 1 hardcode、Phase 2 で registry/KV へ移す) ----
  // Phase 0 で取った snapshot を再利用する EBS volume の元
  ATM11_SNAPSHOT_ID: string;
  // registry.json の cf_record_id を override (TBD_AFTER_REGISTRATION の代わり)
  ATM11_CF_RECORD_ID: string;
  // SSM Parameter Store path for RCON password (例: /gs/atm11/rcon_password)
  ATM11_RCON_PASSWORD_SSM_PATH: string;

  // ---- launcher 配布 (Phase 1) ----
  // EC2 user-data が aws s3 cp で取得する tarball の S3 URI
  // (例: s3://gs-game-configs/launcher/atm11.tar.gz)
  LAUNCHER_TARBALL_S3_URI: string;

  // ---- SNS → Discord 集約 (design.md §4.6) ----
  // 受け付ける SNS Topic ARN。allow list として使う。未設定なら全許可 (本番では必須)。
  SNS_ALLOWED_TOPIC_ARN?: string;
  // 通知を投稿する Discord channel webhook URL
  // Discord channel 設定 → Integrations → Webhooks で発行
  DISCORD_WEBHOOK_URL?: string;

  // ---- KV bindings ----
  // /start 〜 ready 通知の間、interaction の文脈 (token / userId) を一時保存する。
  // optional: 未バインドなら ready 通知は webhook のみ (元メッセージ編集 + mention を skip)。
  // 実体作成: `wrangler kv namespace create SERVER_STATE` → wrangler.toml に id を記載。
  SERVER_STATE?: KVNamespace;
  // GAME_REGISTRY: ゲーム定義 (registry.json) の source of truth。
  // key=<game_id> / value=GameDefinition の JSON。register-game.mjs が投入し、Worker は
  // lib/registry/store.ts 経由で読む。SERVER_STATE と違い必須 — これが無いと全コマンドが
  // 機能しないため graceful degradation はしない。
  // 実体作成: `wrangler kv namespace create GAME_REGISTRY` → wrangler.toml に id を記載。
  GAME_REGISTRY: KVNamespace;
}
