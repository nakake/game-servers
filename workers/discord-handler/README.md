# discord-handler

Cloudflare Worker。Discord interaction を受けて AWS EC2 を操作する制御プレーン。
詳細設計は `docs/design.md` §4。

## ローカル開発

```powershell
# 初回のみ (リポジトリ root で)
pnpm install

# Worker を起動 (http://localhost:8787)
cd workers/discord-handler
pnpm dev
```

動作確認:

```powershell
curl http://localhost:8787/ping
# pong

curl http://localhost:8787/health
# {"status":"ok","worker":"discord-handler","timestamp":"..."}
```

## デプロイ (Phase 1 後半)

```powershell
# 初回のみ
pnpm wrangler login

# 本番反映
pnpm deploy
```

## シークレットの投入

シークレットは Git にコミットせず `wrangler secret put` で Cloudflare 側に置く:

```powershell
pnpm wrangler secret put DISCORD_PUBLIC_KEY
pnpm wrangler secret put DISCORD_BOT_TOKEN
pnpm wrangler secret put AWS_ACCESS_KEY_ID
pnpm wrangler secret put AWS_SECRET_ACCESS_KEY
pnpm wrangler secret put CLOUDFLARE_DNS_API_TOKEN
pnpm wrangler secret put SIDECAR_HMAC_SECRET
```

## ファイル構成 (Phase 1 着地予定)

```
src/
├─ index.ts             # ルーティング
├─ handlers/
│  ├─ discord/
│  │  ├─ start.ts       # /start <game> → EC2 起動
│  │  ├─ stop.ts        # /stop → SSM Run Command docker stop
│  │  ├─ status.ts
│  │  └─ list.ts
│  └─ aws-notification.ts  # SNS → Discord webhook
└─ lib/
   ├─ discord.ts        # ed25519 検証 + response helper
   ├─ aws.ts            # aws4fetch ラッパ (EC2 / SSM / EBS)
   ├─ cloudflare.ts     # DNS API
   └─ registry.ts       # KV アクセス
```
