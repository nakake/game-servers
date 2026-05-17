# Game Servers — 設計ドキュメント

最終更新: 2026-05-17 (rev 2: §4.6 AWS 通知の Discord 集約を追加)

## 1. 目的とスコープ

Discord コマンドから起動・停止できる、複数ゲーム対応のスポット型ゲームサーバー基盤。

### 達成目標

- **コスト**: ATM11 を月 50h プレイで合計 ¥700 / 月以下
- **拡張性**: 新ゲーム追加は登録ファイル 1 個 + DNS レコード 1 個で完結
- **応答性**: Discord コマンド → 起動完了 90 秒以内、停止 30 秒以内
- **データ耐久**: ワールド 3 世代保持 + 週次 S3 バックアップ

### 非目標

- 24 時間稼働 / 高可用性
- 複数ゲーム同時起動(単一 EC2 で 1 ゲームのみ)
- HTTP 系ゲームの Cloudflare proxy 化(将来検討)

---

## 2. 全体アーキテクチャ

```
[Discord]
   │  /start <game>, /stop, /status, /list, /backup <game>
   ▼
[Cloudflare Workers]                         ← フロント/制御プレーン
   │   ├─ KV: GAME_REGISTRY, SERVER_STATE
   │   ├─ Secrets: AWS keys, CF token, Discord pubkey
   │   ├─ Cron: idle フォールバック (1h ごと)
   │   └─ aws4fetch で AWS API 直接呼び出し
   │
   ├──► Cloudflare DNS API (Aレコード更新)
   │
   └──► AWS API
           │
           ▼
        [EC2 Spot Instance]                  ← データ/実行プレーン
           ├─ universal-launcher (game_id を見て該当アダプタ起動)
           ├─ Docker でゲーム本体
           ├─ sidecar: idle 検知 → Workers エンドポイント呼出
           └─ EBS gp3 (game別 snapshot から復元)

        [EBS Snapshot] tag: game=<id>, DLM で 3 世代
        [S3] modpacks/<game>/, saves/<game>/ 週次バックアップ
        [CloudWatch Logs] サーバー/sidecar ログ
```

### コンポーネントの責務

| レイヤー | 役割 | 実装 |
|---|---|---|
| 制御プレーン | Discord 受信、ゲーム選択、EC2 起動指示、DNS 更新 | Cloudflare Workers |
| 状態ストア | ゲーム定義、稼働状態 | Workers KV |
| 認証 | Discord 署名検証、AWS API 署名 | Workers 内 (discord-interactions, aws4fetch) |
| 実行プレーン | ゲームプロセス、データ永続化 | AWS EC2 + EBS |
| バックアップ | 短期世代管理 / 長期保管 | DLM (EBS) + S3 |

---

## 3. ゲーム抽象化レイヤー

### 3.1 game registry スキーマ

```typescript
interface GameDefinition {
  game_id: string;              // "atm11"
  display_name: string;         // "All The Mods 11"
  category: "minecraft-modded" | "minecraft-vanilla" | "terraria" | "valheim" | "factorio";
  enabled: boolean;

  // EC2 起動パラメータ
  instance_types: string[];     // ["m7a.xlarge", "m7i.xlarge", "m6a.xlarge"]
  ebs_size_gb: number;          // 30
  spot_max_price_jpy_per_hour: number | null;  // null = on-demand 上限

  // ネットワーク
  subdomain: string;            // "atm11"
  cf_record_id: string;         // Cloudflare DNS record ID (永続)
  ports: Array<{ port: number; proto: "TCP" | "UDP" }>;

  // ゲーム起動設定
  container_image: string;      // "itzg/minecraft-server:java25"
  env: Record<string, string>;  // {TYPE: "NEOFORGE", VERSION: "26.1.2", MEMORY: "10G"}
  config_s3_prefix: string;     // "s3://mc-server/configs/atm11/"

  // idle 検知設定
  idle_check: {
    type: "minecraft_rcon" | "tshock_rest" | "steam_query" | "factorio_rcon";
    timeout_min: number;        // 10
    config: Record<string, unknown>; // {port: 25575, command: "list"}
  };

  // バックアップポリシー
  snapshot: {
    generations: number;        // 3
    weekly_s3_backup: boolean;  // true
  };
}
```

### 3.2 ゲーム追加フロー

```
1. games/<game_id>/registry.json を作成
2. games/<game_id>/config/  にゲーム設定 (server.properties, JVM args, world template など)
3. scripts/register-game.sh <game_id> 実行
   ├─ Cloudflare DNS A レコード作成 → record_id 取得
   ├─ S3 に config をアップロード
   └─ Workers KV に registry 投入
4. 初回起動: 空 EBS で起動 → ゲーム自動セットアップ → 初回 snapshot 作成
5. Discord で /start <game_id> 確認
```

Lambda/Worker のコード変更も AMI 再ビルドも不要。

### 3.3 idle 検知アダプタ

ゲーム別の差異は sidecar 内のアダプタ層に閉じる:

| category | アダプタ実装 |
|---|---|
| minecraft-* | mcrcon で `list` を実行、`There are 0` を検知 |
| terraria | TShock REST `/v2/server/status` の `playercount` |
| valheim | Steam UDP query (A2S_INFO) |
| factorio | RCON `/players online count` |

`idle_check.type` で sidecar が分岐ロード。

---

## 4. Cloudflare Workers 設計

### 4.1 ルーティング

```
POST /discord/interaction
  ├─ PING → PONG
  ├─ APPLICATION_COMMAND
  │    ├─ /start  → handlers/start.ts
  │    ├─ /stop   → handlers/stop.ts
  │    ├─ /status → handlers/status.ts
  │    ├─ /list   → handlers/list.ts
  │    └─ /backup → handlers/backup.ts
  └─ APPLICATION_COMMAND_AUTOCOMPLETE → game choices from KV

POST /sidecar/idle-detected
  └─ HMAC 認証 → stop フロー起動

POST /sidecar/heartbeat
  └─ 状態 KV 更新 (last_seen, player_count)

POST /aws/notification
  ├─ SNS SubscriptionConfirmation → URL 自動 GET で承認
  └─ SNS Notification → message_type で分岐 → Discord webhook 整形送信

GET /health
  └─ Worker 死活
```

### 4.2 Discord 3 秒制約への対処

```typescript
// handlers/start.ts
export async function handleStart(interaction, env, ctx) {
  const gameId = interaction.data.options[0].value;

  // 即座に deferred response (3秒以内必須)
  const deferredResponse = jsonResponse({
    type: 5,  // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    data: { content: `🚀 ${gameId} を起動中...` }
  });

  // 重い処理は waitUntil で後追い
  ctx.waitUntil(
    startGameAsync(gameId, interaction.token, env)
      .then(result => updateInteractionMessage(interaction.token, result))
      .catch(err => updateInteractionMessage(interaction.token, `❌ ${err.message}`))
  );

  return deferredResponse;
}
```

### 4.3 状態管理 (Workers KV)

```
namespace: GAME_REGISTRY
  key: <game_id>  value: GameDefinition (JSON)

namespace: SERVER_STATE
  key: current     value: { game_id, instance_id, public_ip, started_at, last_player_seen }
  key: history     value: 直近 50 件の起動・停止ログ
```

排他制御: `/start` 時に `current` を読み、`game_id != null` なら確認プロンプト。

### 4.4 認証

| 用途 | 方式 | 保管場所 |
|---|---|---|
| Discord webhook 検証 | ed25519 (Discord public key) | Workers Secrets |
| AWS API 呼び出し | IAM Access Key (Phase 1) / OIDC (Phase 2) | Workers Secrets |
| Cloudflare DNS API | API Token (Zone:DNS:Edit のみ) | Workers Secrets |
| sidecar → Workers | HMAC SHA-256 共有秘密 | Workers Secrets + SSM |

### 4.5 AWS API 呼び出し

`aws4fetch` で signed request:

- EC2: `RunInstances` / `CreateFleet` / `TerminateInstances` / `DescribeInstances`
- EBS: `CreateSnapshot` / `DescribeSnapshots`
- S3: `GetObject` / `PutObject` (modpack/backup)

CPU 時間 < 10ms (free tier 制限) を超えないよう、AWS レスポンス待ちは wall-time のみ消費する設計 (waitUntil 内で sequential await)。

### 4.6 AWS 通知の Discord 集約

AWS からの各種アラートを **メールではなく Discord チャンネルに集約**する。

```
[AWS Budgets / EventBridge / CloudWatch Alarm]
   │  発火イベント
   ▼
[SNS Topic: gs-alerts]
   │  HTTPS subscription
   ▼
[Cloudflare Worker /aws/notification]
   ├─ x-amz-sns-message-type ヘッダで分岐
   │    SubscriptionConfirmation → SubscribeURL を GET して自動承認
   │    Notification          → 本処理
   ├─ Subject / Message を Discord 用に整形
   │    重要度に応じて embed の color 変更 (赤=critical, 黄=warning, 緑=info)
   └─ Discord channel webhook へ POST
```

#### 通知種別と発火元

| 種別 | 発火元 | 重要度 |
|---|---|---|
| Budget アラート (¥3000 到達) | AWS Budgets → SNS | warning |
| Spot 中断警告 | EventBridge `EC2 Spot Instance Interruption Warning` → SNS | critical |
| EC2 起動失敗 | Worker 内で検出 → Discord 直接 | warning |
| DLM snapshot 失敗 | EventBridge `DLM Policy State Change` → SNS | warning |
| IAM ログイン異常 | CloudTrail → EventBridge → SNS | critical |
| 週次バックアップ完了 | Lambda → SNS (or Worker 直接) | info |

#### 設計判断

- **SNS を経由する理由**: AWS 側の通知元 (Budgets / EventBridge / Alarm) は HTTPS 直接配信ではなく SNS 経由が標準。複数の通知元を Worker 1 エンドポイントに集約できる。
- **SubscriptionConfirmation の自動承認**: 初回 subscribe 時に SNS は「URL を GET して確認」を要求する。Worker 側で自動 GET することで手動承認を省略。
- **メール完全廃止しない**: ルートユーザー絡みの AWS からの正式通知 (規約変更、ルートログイン異常) はメール必須なので残す。日常運用通知だけ Discord 化。

詳細実装は Phase 1 (Worker エンドポイント) と Phase 4 (SNS topic + EventBridge ルール) の 2 段階で構築する。

---

## 5. AWS 側設計

### 5.1 ネットワーク

- 既存 default VPC を使用 (新規 VPC は不要)
- パブリックサブネット × 3AZ (ap-northeast-1a/c/d)
- Security Group:
  - `game-server-sg`: ゲーム別ポートをインターネット開放 (registry の `ports` から terraform で生成)
  - `game-server-admin-sg`: SSH 22 を管理者 IP のみ

### 5.2 EC2 / Spot 戦略

- **EC2 Fleet** (`type: instant`, `target-capacity-type: spot`)
- `allocation-strategy: capacity-optimized-prioritized`
- 複数 instance_types を渡して中断率を下げる
- Elastic IP 不使用 (起動毎にパブリック IP が変わる前提で DNS 更新)

### 5.3 AMI

汎用 AMI 一個で全ゲーム対応:

```
Amazon Linux 2023 x86_64
├─ Docker + docker-compose-v2
├─ Corretto 21, 25 (modded MC 用)
├─ awscli v2, jq, mcrcon
└─ /opt/launcher/
    ├─ universal-launcher.sh       cloud-init から呼ばれる
    ├─ adapters/
    │   ├─ minecraft.sh
    │   ├─ terraria.sh
    │   └─ valheim.sh
    └─ sidecar/                    別コンテナで idle 監視
```

cloud-init は以下のみ実行:

```bash
#!/bin/bash
GAME_ID="${game_id}"
SECRET_HMAC="${sidecar_hmac}"
WORKERS_URL="${workers_url}"
/opt/launcher/universal-launcher.sh "$GAME_ID"
```

(Terraform launch template の user-data に変数を埋め込む)

### 5.4 ストレージ層

| データ種別 | 配置 | 耐久戦略 |
|---|---|---|
| OS / Docker / ランチャー | AMI (snapshot) | Packer 再ビルド |
| modpack 配布物 | S3 `modpacks/<game>/` | versioning ON、Glacier 移行なし |
| world / save | EBS gp3 30GB | snapshot 3 世代 + 週次 S3 |
| ゲーム設定 (server.properties等) | S3 `configs/<game>/` | Git 同期 |

### 5.5 Snapshot ライフサイクル

Data Lifecycle Manager (DLM) のポリシー:

```hcl
resource "aws_dlm_lifecycle_policy" "game_world" {
  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Purpose = "game-world" }

    schedule {
      name = "every-stop-3gen"
      create_rule {
        # 手動 trigger (停止 Lambda から CreateSnapshot)
      }
      retain_rule { count = 3 }
      copy_tags = true
    }

    schedule {
      name = "weekly-s3-archive"
      cron_expression = "cron(0 19 ? * SUN *)"  # JST 月 04:00
      # S3 移行はカスタム Lambda で実装
    }
  }
}
```

### 5.6 IAM

| ロール | 用途 | 主要権限 |
|---|---|---|
| `gs-worker-caller` | Workers から AssumeRole / 直接利用 | EC2 RunInstances, EBS CreateSnapshot, S3 GetObject |
| `gs-ec2-instance-role` | EC2 が引き受け | S3 Get/Put (configs, backups), CloudWatch Logs, SSM ParameterGet |
| `gs-dlm-role` | DLM が引き受け | EBS Snapshot 作成・削除 |

Phase 1 は Access Key、Phase 2 で Cloudflare Workers OIDC → AssumeRole に切替。

---

## 6. モノレポ構成

```
F:/project/game_servers/
├─ README.md
├─ CLAUDE.md                     # Claude Code 用ガイド
├─ docs/
│  ├─ design.md                  # 本ファイル
│  ├─ runbook.md                 # 運用手順
│  └─ adr/                       # 設計判断記録
│     └─ 0001-cloudflare-vs-lambda.md
│
├─ workers/                      # Cloudflare Workers (TypeScript)
│  ├─ discord-handler/
│  │  ├─ src/
│  │  │  ├─ index.ts
│  │  │  ├─ handlers/
│  │  │  │  ├─ start.ts
│  │  │  │  ├─ stop.ts
│  │  │  │  ├─ status.ts
│  │  │  │  ├─ list.ts
│  │  │  │  ├─ backup.ts
│  │  │  │  ├─ sidecar-idle.ts
│  │  │  │  └─ aws-notification.ts    # SNS → Discord 通知集約
│  │  │  └─ lib/
│  │  │     ├─ discord.ts        # 署名検証、レスポンス生成
│  │  │     ├─ aws.ts            # aws4fetch ラッパ
│  │  │     ├─ cloudflare.ts     # DNS API
│  │  │     └─ registry.ts       # KV アクセス
│  │  ├─ wrangler.toml
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  └─ shared/                    # workspace 共有
│     └─ types/
│        └─ game-definition.ts
│
├─ infra/                        # AWS Terraform
│  ├─ modules/
│  │  ├─ launch-template/
│  │  ├─ security-group/
│  │  ├─ dlm-policy/
│  │  └─ iam/
│  └─ envs/
│     └─ prod/
│        ├─ main.tf
│        ├─ backend.tf
│        └─ terraform.tfvars
│
├─ ami/                          # Packer
│  ├─ universal-game-server.pkr.hcl
│  └─ provisioners/
│     ├─ install-docker.sh
│     ├─ install-java.sh
│     └─ install-launcher.sh
│
├─ launcher/                     # EC2 上で動くコード
│  ├─ universal-launcher.sh
│  ├─ adapters/
│  │  ├─ minecraft.sh
│  │  ├─ terraria.sh
│  │  └─ valheim.sh
│  └─ sidecar/
│     ├─ Dockerfile
│     ├─ src/
│     │  ├─ main.ts
│     │  └─ adapters/
│     └─ package.json
│
├─ games/                        # ゲーム定義
│  ├─ _template/
│  │  ├─ registry.json
│  │  └─ config/
│  ├─ atm11/
│  │  ├─ registry.json
│  │  ├─ config/
│  │  │  ├─ user_jvm_args.txt
│  │  │  └─ server.properties
│  │  └─ README.md
│  └─ vanilla/
│
├─ scripts/                      # 開発・運用
│  ├─ register-game.sh
│  ├─ deploy-worker.sh
│  ├─ build-ami.sh
│  ├─ snapshot-list.sh
│  └─ restore-from-s3.sh
│
├─ .github/
│  └─ workflows/
│     ├─ worker-deploy.yml       # workers/** 変更で wrangler deploy
│     ├─ ami-build.yml           # ami/** 変更で packer build
│     └─ terraform-plan.yml
│
├─ package.json                  # monorepo root (pnpm)
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ .editorconfig
└─ .gitignore
```

### 6.1 ツール選定

| 領域 | ツール | 理由 |
|---|---|---|
| Monorepo 管理 | pnpm workspaces | Workers 開発が TS/JS なので素直 |
| Workers デプロイ | Wrangler | 公式 |
| AWS IaC | Terraform | 実績、HCL のモジュール化容易 |
| AMI ビルド | Packer | AL2023 標準ワークフロー |
| sidecar | Node.js / TypeScript (Docker container) | Workers と型共有可能 |
| ランチャー | bash (POSIX) | 環境依存最小、AMI に焼き込み |

### 6.2 命名規約

- ファイル: kebab-case
- TypeScript シンボル: camelCase / PascalCase
- terraform リソース: snake_case、プレフィックス `gs-` (game servers)
- AWS タグ: `Project=game-servers`, `Game=<game_id>`, `Env=prod`

---

## 7. データフロー

### 7.1 起動シーケンス

```
[User] Discord で /start atm11
   ▼
[Discord] interaction を Workers に POST
   ▼
[Worker discord-handler]
   1. ed25519 検証
   2. SERVER_STATE.current を確認 (排他)
   3. deferred response 返答 (3秒以内)
   4. ctx.waitUntil で非同期処理開始:
      a. GAME_REGISTRY.atm11 取得
      b. EBS スナップショット最新版を Tag=game:atm11 で検索
      c. EC2 Fleet 作成 (latest snapshot から復元する LaunchTemplate)
      d. EC2 状態が "running" になるまで polling
      e. パブリック IP 取得
      f. Cloudflare DNS API: atm11.example.com → IP
      g. SERVER_STATE.current 更新
      h. Discord webhook で完了メッセージ
   ▼
[EC2] cloud-init 実行
   1. universal-launcher.sh atm11
   2. /opt/games/atm11 に EBS をマウント
   3. configs を S3 から sync
   4. adapters/minecraft.sh 起動
   5. docker compose up -d (mc server + sidecar)
   ▼
[sidecar] 1分後から RCON 監視開始
```

### 7.2 停止シーケンス

```
[トリガー] 以下のいずれか:
   - Discord /stop コマンド
   - sidecar の idle 検知 (0人 10分) → Workers POST /sidecar/idle-detected
   - Workers cron (1h ごとフォールバック)
   ▼
[Worker]
   1. RCON 経由で graceful stop コマンド
      mc: /save-all → /stop
      terraria: /exit
   2. プロセス停止確認 (CloudWatch Logs か EC2 metric)
   3. EBS Snapshot 作成 (tag: game=atm11, Purpose=game-world)
   4. Snapshot 完了確認
   5. EC2 Terminate
   6. SERVER_STATE.current = null
   7. Discord webhook で停止通知
   ▼
[DLM] 3 世代超過分を自動削除
```

### 7.3 障害対応

| 事象 | 検知 | 復旧 |
|---|---|---|
| Spot 中断通知 | EC2 IMDS の interruption notice | sidecar が即 graceful stop → snapshot |
| sidecar 死亡 | Workers cron で last_heartbeat チェック | 1h 経過で強制停止 |
| EC2 起動失敗 | Worker の polling timeout (5分) | Discord で失敗通知、Worker は state クリア |
| DNS 更新失敗 | API レスポンス | ロールバック (EC2 terminate) |
| snapshot 作成失敗 | API レスポンス | EC2 は維持、Discord で警告、手動対応 |

---

## 8. コスト試算

### 8.1 月額(50h ATM11 + 20h Vanilla + 10h Terraria)

| 項目 | 内訳 | 月額 |
|---|---|---|
| EC2 spot m7a.xlarge (ATM11 50h) | ¥9/h | ¥450 |
| EC2 spot t4g.medium (Vanilla 20h) | ¥3/h | ¥60 |
| EC2 spot t4g.small (Terraria 10h) | ¥1.5/h | ¥15 |
| EBS gp3 30GB (稼働時のみ加重平均 10h) | ¥1.5/GB/月 | ¥10 |
| EBS Snapshot 3 ゲーム × 3 世代 (~60GB) | ¥0.7/GB/月 | ¥45 |
| S3 (30GB modpacks + backups) | ¥3/GB/月 | ¥90 |
| CloudWatch Logs (EC2 のみ) | | ¥15 |
| データ転送 (out) | 100GB 無料枠内 | ¥0 |
| Cloudflare Workers / KV / DNS | 全て無料枠内 | **¥0** |
| **合計** | | **¥685/月** |

### 8.2 コストドライバー感応度

| 変数 | +1 単位の影響 |
|---|---|
| ATM11 プレイ +10h | +¥90/月 |
| ゲーム追加 (idle) | +¥30〜50/月 (snapshot のみ) |
| EBS サイズ +10GB | +¥15 + snapshot +¥7 |
| プレイ人数 +1 | データ転送増、無料枠超で +¥17/GB |

### 8.3 上限ガード

- AWS Budgets でアラート 2 段階 ($15 / $20 ≒ ¥2,250 / ¥3,000)
- 通知は **SNS → Worker → Discord** 経由 (詳細 §4.6)。Phase 0〜初期は メール直送、Phase 1 で Discord 化
- EC2 Fleet の max_spot_price を JPY 換算で設定 (registry 値を Terraform に注入)

---

## 9. セキュリティ

| 領域 | 対策 |
|---|---|
| Discord 認証 | ed25519 署名検証必須、検証失敗で 401 |
| AWS 認証 | 最小権限 IAM、Phase 2 で OIDC 移行 |
| 鍵管理 | Workers Secrets / SSM Parameter Store (SecureString)、Git に絶対 commit しない |
| sidecar → Worker | HMAC SHA-256、payload に timestamp、5 分以上古いリクエスト拒否 |
| ゲームポート | 必要ポートのみ開放、SSH は管理者 IP のみ |
| ログ | プレイヤー IP は CloudWatch にも保存しない (server.properties で log-ips=false) |

---

## 10. 構築フェーズ計画

各フェーズは独立して動作確認可能なゴールを持つ。

### Phase 0: 検証 (1〜2 日) — 完了 (2026-05-17)

- [x] AWS マネコンで手動 EC2 (m7a.xlarge spot) 起動
- [x] ATM11 を 10GB ヒープで起動、5 分プレイ
- [x] `spark profiler` で mspt、heap、GC 計測
- [x] EBS snapshot 手動作成 → 別 EC2 から復元動作確認

ゴール: インスタンスタイプと EBS サイズの確定 — **達成** (詳細は `docs/phase0-results.md`)

### Phase 1: Workers 最小実装 (2〜3 日)

- [ ] Cloudflare アカウント、Wrangler セットアップ
- [ ] Discord アプリ登録、Bot Token 取得
- [ ] Worker で `/ping` 応答
- [ ] Worker から手動 EC2 起動 / 停止 (`/start atm11` ハードコード)
- [ ] Cloudflare DNS API で A レコード更新
- [ ] Worker `/aws/notification` 実装 (SNS subscription confirm + Discord 整形)
- [ ] 手動で SNS topic 作成 → Budget アラートを Discord に切替

ゴール: Discord から ATM11 を上げ下げできる、Budget 通知も Discord に届く

### Phase 2: ゲーム抽象化 (2 日)

- [ ] Workers KV に GAME_REGISTRY 投入
- [ ] registry 駆動で Worker 動作
- [ ] 2 個目のゲーム (Vanilla 1.21) を追加して動作確認

ゴール: ゲーム追加が registry 更新だけで完結

### Phase 3: 自動停止 (2 日)

- [ ] sidecar コンテナ実装 (TypeScript / Docker)
- [ ] idle 検知 → Workers POST → 停止フロー
- [ ] DLM ポリシー Terraform 化
- [ ] Workers cron フォールバック

ゴール: 放置で勝手に停止する

### Phase 4: IaC 化 + 通知拡張 (3〜5 日)

- [ ] Terraform で AWS リソース全部記述
- [ ] Packer で AMI ビルド
- [ ] GitHub Actions で worker / AMI / terraform CI
- [ ] runbook.md 整備
- [ ] SNS topic `gs-alerts` を Terraform 化、Worker URL に subscribe
- [ ] EventBridge ルール追加 (Spot 中断警告, DLM 失敗) → SNS → Discord
- [ ] CloudTrail → EventBridge で IAM ログイン異常検知 → Discord
- [ ] 週次バックアップ完了通知 (info レベル)

ゴール: 完全コード化、災害復旧 1 時間以内、AWS 通知が Discord に集約

### Phase 5 (任意): OIDC 化、Terraria 追加など

---

## 11. 未決事項 / Open Questions

- [ ] OIDC vs Access Key の切り替えタイミング (Phase 2 末で再評価)
- [ ] world データの S3 ライフサイクル (90 日 Glacier 移行?)
- [ ] 複数プレイヤー時のデータ転送量実測 → 無料枠超過閾値
- [ ] ATM11 で Xmx 10GB 実運用可能か (Phase 0 で判定)
- [ ] Spot 中断時の world ロスト対策 (interruption notice → 2 分以内 graceful stop で間に合うか)

---

## 12. 参考リンク

- Cloudflare Workers: https://developers.cloudflare.com/workers/
- aws4fetch: https://github.com/mhart/aws4fetch
- Discord Interactions: https://discord.com/developers/docs/interactions/receiving-and-responding
- EC2 Fleet: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-fleet.html
- DLM: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/snapshot-lifecycle.html
- itzg/minecraft-server: https://github.com/itzg/docker-minecraft-server
