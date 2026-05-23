# sidecar — idle detection + heartbeat

Phase 3 で導入された sidecar コンテナ。EC2 上で **game コンテナと並走** し、ゲームに idle 検知
プロトコル (RCON / REST 等) でポーリングしながら Cloudflare Worker に状況を報告する。

`docs/phase3-plan.md` の Step 4 の実装。

## 役割

1. **heartbeat**: `heartbeat_interval_sec` ごとに `/sidecar/heartbeat` を打って Worker に生存と
   player count を伝える。Worker は KV `last-seen:<game_id>` を更新する。
2. **idle 通知**: 連続して `timeout_min` 分プレイヤー 0 を観測したら `/sidecar/idle-detected` を
   打って Worker の `runStopWorkflow` を発火させる。
3. **registry 取得**: 起動時に Worker `/sidecar/registry?game_id=<id>` を 1 回叩いて
   `idle_check` の仕様 (type / config / 閾値) を取得する。KV は Worker 経由で参照する設計
   (`docs/phase3-plan.md` 決定8)。

sidecar が落ちても Worker 側の Cron フォールバック (5 分 cron) が `timeout_min + 5min` 沈黙で
強制停止するため、二重防御になっている。

## 設計上の決定 (`docs/phase3-plan.md`)

- HMAC SHA-256、payload は POST `${timestamp}\n${body}` / GET `${METHOD}\n${path?query}\n${ts}` (決定10)
- HMAC secret は SSM SecureString `/gs/<game_id>/sidecar_hmac_secret`
- adapter は `idle_check.type` で分岐。Phase 3 では `minecraft_rcon` のみ実装、他は throw

## 開発

`launcher/sidecar/` は **pnpm workspace 外**の独立 npm パッケージ。Docker image を単独で
build しやすくするための意図的な構成 (`pnpm-workspace.yaml` 参照)。

```pwsh
cd launcher/sidecar
npm ci             # 初回 / package-lock.json 変更時
npm run typecheck
npm test
npm run build      # → dist/
```

Docker image:

```pwsh
docker build -t gs-sidecar:latest launcher/sidecar
```

本番では Step 7 (AMI 再ビルド) で Packer がこの image を `docker save` して AMI に同梱する。

## ローカル統合テスト

`launcher/images/atm11/docker-compose.yml` に sidecar サービスを追加するのは Step 6
(user-data + docker-compose 統合) で行う。Step 4 単独では Docker image が build できて、
unit test (HMAC 相互互換性 / RCON レスポンスパース) が通るところまで。

## 環境変数 (cloud-init から渡す)

| 変数 | 必須 | 説明 |
|---|---|---|
| `GAME_ID` | yes | `atm11` 等。registry 取得や SSM パス組み立てに使う |
| `WORKER_URL` | yes | Worker のベース URL (`https://discord-handler.<acct>.workers.dev`)。末尾スラッシュは削る |
| `AWS_REGION` | no | SSM 呼び出し先。省略時 `ap-northeast-1` |

`instance_id` は IMDSv2 で sidecar 自身が取得 (env で渡さない)。
