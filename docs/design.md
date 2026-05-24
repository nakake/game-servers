# Game Servers — 設計ドキュメント

最終更新: 2026-05-24 (rev 6: Phase 4 完了。idle 停止 / Spot 中断 / cron 失敗の Discord 集約通知が本番稼働。公開前残るは Phase 5 OIDC のみ)

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

        [EBS Snapshot] tag: Game=<id>, Worker Cron で 3 世代
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
| バックアップ | 短期世代管理 / 長期保管 | Worker Cron (EBS snapshot) + S3 |

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
3. node scripts/register-game.mjs <game_id> 実行
   ├─ Cloudflare DNS A レコード作成 → record_id を registry.json に書き戻し
   ├─ S3 に config をアップロード (aws s3 sync)
   └─ Workers KV (GAME_REGISTRY) に registry 投入
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

POST /sidecar/idle-detected           ← Phase 3 実装済
  └─ HMAC 認証 → ctx.waitUntil(runStopWorkflow({triggeredBy:'sidecar'}))
     + expectedInstanceId ガード (古い instance からの晩到 stop 防止)

POST /sidecar/heartbeat               ← Phase 3 実装済
  └─ HMAC 認証 → SERVER_STATE `last-seen:<game>` を上書き (TTL = timeout_min*3 分)

GET  /sidecar/registry?game_id=<id>   ← Phase 3 実装済 (決定8)
  └─ HMAC 認証 → KV から GameDefinition を JSON 返却 (sidecar 起動時に 1 回)

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
| AWS API 呼び出し | **OIDC AssumeRoleWithWebIdentity → 15min 短期 credentials** (Phase 5 で長期 Access Key を排除) | private key: Workers Secret (`OIDC_PRIVATE_KEYS_JWK`) / sub claim: Workers Secret (`OIDC_SUB`) / role ARN: vars (`AWS_OIDC_ROLE_ARN`) |
| Cloudflare DNS API | API Token (Zone:DNS:Edit のみ) | Workers Secrets |
| sidecar → Workers | HMAC SHA-256 共有秘密 (game 別、Phase 3 実装) | Workers Secrets (`SIDECAR_HMAC_SECRETS` JSON map) + SSM `/gs/<game>/sidecar_hmac_secret` |

OIDC 経路の詳細は `docs/phase5-plan.md` + `docs/runbook-phase5-oidc.md`。Worker 自身が OIDC issuer (RS256 JWT + JWKS endpoint) を兼ね、AWS IAM OIDC provider が JWKS を検証する。private key は multi-kid 並走対応で 6 ヶ月毎 rotation。

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

ワールド world は `/stop` のたびに Worker が CreateSnapshot で snapshot を取り (§7.2)、
直近 `generations` 世代 (registry.json `snapshot.generations`、ATM11 は 3) だけを残す。

**世代管理は Worker 側で行う。DLM (Data Lifecycle Manager) は使わない。** DLM の EBS
スナップショット管理ポリシーは「DLM 自身がスケジュールで作成した snapshot」しか保持・削除
できず、Worker が CreateSnapshot で作る snapshot は `target_tags` が一致しても管理対象外に
なる。当初は DLM に委譲する設計だったが、DLM には「外部が作成した snapshot を世代管理する」
機能が存在しないため断念した (経緯は `docs/iac-migration-plan.md` Step 6)。

- **作成**: Worker `/stop` フローが `/dev/sdf` の data volume を CreateSnapshot。
  tag: `Game=<id>` / `Purpose=game-world` / `SnapshotType=game-world-data` (snapshot 専用マーカー)。
- **世代管理**: Worker の Cron (`handlers/snapshot-retention.ts`、5 分間隔) が Game ごとに
  completed snapshot を startTime 降順に並べ、`generations` 本目より古いものを DeleteSnapshot。
  pending (= `/stop` 直後の最新分) は次 tick へ繰り越し、error は手動対応に倒す。
- **週次 S3 バックアップ** (`weekly_s3_backup`): 長期保管用。Phase 3 以降にカスタム Lambda /
  Worker で別途実装する (本節のスコープ外)。

### 5.6 IAM

| ロール | 用途 | 主要権限 | 認証経路 |
|---|---|---|---|
| `gs-worker-oidc-role` | Workers が OIDC で assume | EC2 RunInstances (LT + InstanceType + RequestTag/Env=prod 制約) / Terminate / DescribeSnapshots / DeleteSnapshot (SnapshotType=game-world-data 限定) / DescribeVolumes / DeleteVolume / SSM SendCommand+GetCommandInvocation / PassRole | AssumeRoleWithWebIdentity (15min session)、trust policy condition `aud + sub` |
| `gs-phase0-ec2-role` | EC2 instance role | AWS マネージド `AmazonSSMManagedInstanceCore` + `AmazonS3ReadOnlyAccess` + inline `sns:Publish` (gs-alerts topic 限定) | EC2 instance profile (auto) |

Phase 1〜4 で使っていた IAM user `gs-worker-caller` + 長期 Access Key + wildcard `Resource = "*"` policy は **Phase 5 (2026-05-24) で全廃止**。Worker → AWS の長期 credential は構造的に存在しなくなった。詳細は `docs/phase5-plan.md` + `infra/envs/prod/iam.tf` + `infra/modules/aws-oidc-cloudflare/`。

`gs-worker-oidc-policy` は **resource type ごとに条件付き多 statement** で設計 (`ec2:RunInstances` は instance resource にのみ LT/Type/RequestTag 厳格条件、それ以外の resource type は無条件 allow で AWS の context attach 仕様を吸収)。cryptojacking 抑止は instance resource 評価で代理担保される。

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
│  ├─ register-game.mjs
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

> **注**: 「Worker → RCON 直叩き」案は [ADR 0002](adr/0002-mc-stop-flow-docker-ssm.md) で **Docker + SSM Run Command** 構成に置き換わった。以下はその改訂版。

```
[トリガー] 以下のいずれか:
   - Discord /stop コマンド
   - sidecar の idle 検知 (0人 10分) → Workers POST /sidecar/idle-detected
   - Workers cron (1h ごとフォールバック)
   ▼
[Worker]
   1. SSM SendCommand: `docker stop --time=60 mc`
   2. SSM GetCommandInvocation で status=Success 待ち (max 90s)
   3. EBS Snapshot 作成 (tag: game=<id>, Purpose=game-world)
   4. Snapshot 完了確認
   5. EC2 Terminate
   6. SERVER_STATE.current = null
   7. Discord webhook で停止通知
   ▼
[EC2 (SSM agent) → docker]
   docker stop --time=60 mc
     ├─ container 内 entrypoint.sh の trap (SIGTERM)
     │     mcrcon → save-all flush
     │     mcrcon → stop
     └─ java exit → container Stopped
   ▼
[Worker Cron] 3 世代超過分を自動削除 (handlers/snapshot-retention.ts、§5.5)
```

ゲーム別の graceful stop コマンドは container 内 `entrypoint.sh` の trap に閉じる (mc: rcon `save-all && stop`, terraria: `/exit` 等)。Worker は **常に `docker stop`** を発火するだけで、ゲーム固有のコマンドを知る必要がない。

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

### Phase 1: Workers 最小実装 (2〜3 日) — 完了 (2026-05-21)

- [x] Cloudflare アカウント、Wrangler セットアップ
- [x] Discord アプリ登録、Bot Token 取得
- [x] Worker で `/ping` 応答
- [x] Worker から手動 EC2 起動 / 停止 (`/start atm11` ハードコード)
- [x] Cloudflare DNS API で A レコード更新
- [x] Worker `/aws/notification` 実装 (SNS subscription confirm + Discord 整形)
- [x] 手動で SNS topic 作成 → Budget アラートを Discord に切替

ゴール: Discord から ATM11 を上げ下げできる、Budget 通知も Discord に届く

> `/start` → `/stop` → 再 `/start` で world 永続性まで実機検証済 (2026-05-21)。EBS snapshot
> 引き継ぎ (pending 完成待ち + Cron での volume 回収) と Budget→SNS→Discord 通知も実機確認済で
> Phase 1 のゴールを達成。残りは月コストの実測のみ (§8 試算 ¥685/月 の検証)。

### Phase 2: ゲーム抽象化 (registry 駆動基盤) — 完了 (2026-05-23)

- [x] Workers KV に GAME_REGISTRY 投入 (atm11)
- [x] registry 駆動で Worker 動作 (build-time import を撤去、`atm11` リテラルを Worker から除去)
- [x] Discord `/start` `/stop` の game 引数 autocomplete 化 (KV 由来)
- [x] `scripts/register-game.mjs` 実装 (DNS + S3 + KV 一括投入)
- [x] ATM11 で `/start` → `/stop` → 再 `/start` の回帰確認

ゴール: ゲーム追加用の **registry 駆動レイヤー** が整い、Worker コードに新ゲーム追加で触らない構造になる。

> Phase 2 当初計画にあった「2 個目のゲーム (Vanilla 1.21) 追加実証」は **Phase 6 に切り出し**
> た (公開前の Phase 3〜5 を優先するため)。詳細は `docs/phase2-plan.md`。

### Phase 3: 自動停止 — 完了 (2026-05-23)

- [x] sidecar コンテナ実装 (TypeScript / Docker、`launcher/sidecar/`)
- [x] idle 検知 → `/sidecar/idle-detected` → `runStopWorkflow` (`triggeredBy: 'sidecar'`)
- [x] snapshot 世代管理 (Worker Cron、§5.5、IaC migration Step 6 で実装済 → Phase 3 では sidecar 連携を追加)
- [x] Workers cron フォールバック (sidecar 沈黙時の保険、5 分 cron に `handleIdleFallback` 追加)
- [x] Packer 導入 (`ami/`) を Phase 4 から前倒し。sidecar image を AMI に `docker load -i /var/lib/sidecar-image.tar` で起動時ロード

ゴール: 放置で勝手に停止する。**達成** — ATM11 で 10 分 idle → 自動 snapshot + terminate、world 永続性 + Discord `/stop` 回帰すべて実機確認済 (`docs/phase3-plan.md` §完了基準、`docs/runbook-phase3-sidecar.md` §Step 6)。Cron フォールバックの **発火そのもの** だけ実機未検証だが、`idle-fallback.test.ts` の unit test でロジックは固めてあり、skip 経路 (`within-window`) は実機ログで確認済。

### Phase 4: 通知拡張 — 完了 (2026-05-24)

Terraform 化 / Packer / GitHub Actions の項目は IaC migration (`docs/iac-migration-plan.md`) で完了済。本 Phase は **AWS 通知の Discord 集約強化** に絞った (詳細 `docs/phase4-plan.md`)。

- [x] EventBridge ルール (Spot 中断警告) → SNS → Discord の専用整形 (`isSpotInterruptionMessage` + `buildSpotInterruptionEmbed`、generic 整形だと title が "AWS notification" になり一目で内容が分からない問題を解消)
- [x] sidecar / cron-fallback idle 停止通知 → Discord (`buildIdleStopNotification`、Discord `/stop` の二重通知は元 interaction の follow-up edit で抑止)
- [x] Worker Cron snapshot 世代管理 / volume cleanup の失敗通知 → Discord (`notif-suppress` で 1 時間 1 回まで)
- [-] CloudTrail → EventBridge で IAM ログイン異常検知 → Discord (持ち越し、運用しながら必要なら追加)
- [-] 週次バックアップ完了通知 (バックアップ自体が未実装、別 Phase で実装と同時に)

ゴール: **達成** — ATM11 の idle 停止 / Spot 中断 (B1 SNS 直接 publish) / 既存 Budget アラートの回帰、すべて実機検証済 (`docs/runbook-phase4-notifications.md` §確認まとめ)。snapshot 失敗通知は実機での意図的失敗発火が困難なため unit test + コードレビューで担保 (`notif-suppress.test.ts` + `notifications.test.ts` の cron 失敗 embed 6 ケース)。

### Phase 5: OIDC 化 + IAM policy tightening — 完了 (2026-05-24)

- [x] Cloudflare Workers → AWS AssumeRole の OIDC 信頼関係を Terraform で構築 (`infra/modules/aws-oidc-cloudflare/`、trust policy condition `aud + sub`)
- [x] Worker 自身を OIDC issuer 化 (RS256 JWT + JWKS endpoint + discovery doc、multi-kid 並走対応、`lib/auth/oidc-issuer.ts`)
- [x] Worker AWS credential provider (`lib/aws/credentials.ts`、KV cache + in-flight dedup + 負方向 jitter TTL + STS failure sentinel)
- [x] 全 7 callsite を `getAwsCredentials(env, ctx)` 経由に統一
- [x] **IAM policy tightening**: 旧 wildcard `Resource = "*"` policy を resource type 別 statement に分解、`ec2:RunInstances` は instance resource に LT ARN + InstanceType allow list + RequestTag/Env=prod 強制、`ec2:DeleteSnapshot` は SnapshotType=game-world-data 限定で Packer AMI snap 構造的保護
- [x] 既存 IAM Access Key + IAM user `gs-worker-caller` + 旧 policy を全削除 (24h 観察短縮、検証ギルド = staging 兼用判断で 2.3h 観察に圧縮、rollback 不可確定)
- [x] design.md §5.6 / §4.4 を OIDC 前提に更新 (本 commit)
- [x] `docs/runbook-phase5-oidc.md` に事前確認 / 定期 rotation / 緊急 rotation / thumbprint 検証 / DoS rate limit / rollback 全手順を残す

ゴール達成: Workers Secrets から長期 Access Key を排除済。公開後のクレデンシャル流出時の影響範囲は **15min STS session + tag/LT/InstanceType 制約 policy** に絞られた。詳細は `docs/phase5-plan.md` + `docs/runbook-phase5-oidc.md`。

### Phase 6 (将来): 新ゲーム追加実証 / 次バージョン機能

Phase 2 の足場の上で実施するゲーム拡張。**公開後の次バージョンで取り組む**。

- [ ] **Vanilla 1.21 を追加** (Phase 2 Step 7 から移譲): `games/vanilla/` を `games/_template/` からコピー、`image_source: "pull"` で `itzg/minecraft-server:java21` を使う。`node scripts/register-game.mjs vanilla` のみで `/list` `/start` `/stop` が通り、**Worker のコード変更ゼロ** であることを確認 (= Phase 2 のゴール実証)
- [ ] **blank EBS 初回 `mkfs` 経路の実機確認**: 種 snapshot を持たない新ゲームの初回起動が壊れていないか
- [ ] **`docker pull` 経路の実機確認**: `image_source: "pull"` の経路が `build` と同等に動くか
- [ ] **Cloudflare DNS の IaC 化要否を判断** (`docs/iac-migration-plan.md` Step 9 移管): `register-game.mjs` の運用実績を見てから決める
- [ ] **Terraria / Valheim 等の追加** (任意): 別 category の検証で sidecar idle 検知アダプタを実装

ゴール: ゲーム追加が **registry 更新だけで完結する** ことを 2 個目以降のゲームで実証。

---

## 11. 未決事項 / Open Questions

- [x] OIDC vs Access Key の切り替えタイミング (Phase 2 末で再評価 2026-05-23 → Phase 5 として公開前に実施に確定 → 2026-05-24 完了)
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
