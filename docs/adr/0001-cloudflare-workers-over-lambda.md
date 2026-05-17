# ADR 0001: 制御プレーンに Cloudflare Workers を採用する

- **Status**: Accepted
- **Date**: 2026-05-17
- **Deciders**: ryota
- **Related**: `docs/design.md` §4

## Context

Discord スラッシュコマンドを受信し、AWS EC2 Spot の起動・停止・状態問い合わせ・DNS 更新を行う **制御プレーン** の実行基盤を決める必要がある。

### 主な要件

1. **Discord 3 秒応答制約**: interaction 受信から 3 秒以内に最初の応答を返さないと Discord 側でタイムアウト。コールドスタートが致命的になる。
2. **低頻度・短時間**: 起動コマンドは月数十回程度。1 回あたり 30 秒以内に完了。
3. **AWS API 呼び出し**: EC2 Fleet / EBS Snapshot / S3 を操作する必要。
4. **DNS 更新**: ドメインは Cloudflare 管理。spot の動的 IP に毎回 A レコードを更新。
5. **状態保持**: 「現在どのゲームが起動中か」「最終 player_seen 時刻」などを跨セッションで保持。
6. **低コスト**: 制御プレーン全体で月 ¥100 未満が目標。
7. **拡張性**: 将来 Terraria / Valheim / Factorio 等を追加してもコード本体は変えたくない (registry 駆動)。

### 候補

| 候補 | 概要 |
|---|---|
| A. **AWS Lambda + API Gateway** | 記事 (https://zenn.dev/daikitchen/articles/ac794d03b9baf3) と同構成 |
| B. **Cloudflare Workers** ★採用 | エッジ実行、Discord webhook → AWS API を直接呼び出し |
| C. **EC2 t4g.nano 常時稼働 + 自前 web サーバー** | コントロールサーバー自身が常時起動 |
| D. **Discord Bot (gateway 接続) を自宅 PC で常駐** | Webhook ではなく WebSocket gateway 経由 |

## Decision

**Cloudflare Workers** を採用する。

### 実装方針

- **言語**: TypeScript
- **デプロイ**: Wrangler
- **状態保持**: Workers KV (game registry, server state)
- **シークレット**: Workers Secrets
- **AWS API 呼び出し**: `aws4fetch` ライブラリで signed request
- **長時間処理**: `ctx.waitUntil()` + Discord deferred response (type 5) で 3 秒制約をクリア
- **認証 Phase 1**: AWS IAM Access Key を Workers Secrets に保存
- **認証 Phase 2**: Cloudflare OIDC → AWS IAM Role の AssumeRole (将来移行)
- **idle フォールバック**: Cron Triggers (1 時間毎)

## Consequences

### Positive

#### 1. コールドスタート消滅 (最重要)

- Lambda の初回起動は 100ms 〜 1.5 秒。Discord 3 秒制約に対し、TLS handshake と signature 検証を足すと不安定。
- Workers は V8 isolate ベースで実質コールドスタート 0ms。
- 月数十回呼び出し = ほぼ毎回コールドな運用パターンで Workers が圧倒的に有利。

#### 2. Edge レイテンシ

- Discord の webhook は US Central 中心。Cloudflare の東京 edge から Discord までは平均 100ms 程度、Lambda (Tokyo region) からだと往復含めて 200ms 超。
- Workers なら deferred response がほぼ即時届く。

#### 3. デプロイの簡潔さ

| 観点 | Lambda | Workers |
|---|---|---|
| デプロイコマンド | zip → S3 → Lambda update → API GW 配置 | `wrangler deploy` 一発 |
| ローカル実行 | sam local / serverless | `wrangler dev` |
| シークレット投入 | SSM / Secrets Manager + IAM | `wrangler secret put` |
| Terraform 行数 (実測見積) | 200+ 行 | KV namespace の数行のみ |

#### 4. コスト

| 項目 | Lambda 構成 | Workers 構成 | 差 |
|---|---|---|---|
| 関数実行費 | ¥10/月 (1M req 無料枠内だが GB-s 課金) | ¥0 (100k req/日 無料) | -¥10 |
| API GW | ¥5/月 (リクエスト課金) | ¥0 (Workers 内蔵) | -¥5 |
| 状態ストア | DynamoDB ¥0 (無料枠) | KV ¥0 (無料枠) | 同等 |
| ログ | CloudWatch ¥20/月 | Workers Logs ¥0 (basic) | -¥20 |
| **合計差** | | | **-¥35/月** |

絶対額は小さいが、無料枠の余裕度が圧倒的 (Workers free: 100k req/日 = 月 300 万)。

#### 5. シークレット管理の手間

- Lambda: SSM Parameter Store / Secrets Manager + IAM policy + 関数内で取得コード
- Workers: `wrangler secret put NAME` の 1 コマンド、コード側は `env.NAME` で参照

#### 6. 拡張性

- 将来 Cloudflare R2 (S3 互換、egress 無料) や D1 (SQLite) への移行が容易。
- Discord 以外のフロント (Web UI、Slack 等) を追加する場合も Workers ルーティングで完結。

### Negative / Trade-off

#### 1. インフラベンダー二者構成

- Cloudflare + AWS の 2 プロバイダー前提。請求書も 2 つ。
- 障害時の切り分けが複雑化 (どっち側の問題か)。
- **緩和策**: 制御プレーン (CF) と実行プレーン (AWS) で責務が明確に分かれているため、切り分けは category レベルで容易。

#### 2. AWS API 呼び出しに長期キーが必要 (Phase 1)

- Workers から AWS を叩くには IAM Access Key を Workers Secrets に保存する形になる。
- 長期キーは漏洩リスクあり、IAM ベストプラクティスから外れる。
- **緩和策**:
  - Phase 1 は最小権限の専用 IAM ユーザー (EC2 起動・停止・snapshot 作成のみ)
  - キーローテーション手順を runbook に明記
  - Phase 2 で Cloudflare Workers OIDC provider を IAM Identity Provider 登録 → AssumeRole に移行

#### 3. Workers 実行時間制限

- 無料プラン: 10ms CPU / リクエスト
- 有料 ($5/月): 30 秒 CPU / リクエスト
- ただし **wall clock time** (外部 API 待ち) は CPU 時間にカウントされない。
- AWS API 呼び出しはほぼ wall clock なので、無料プランでも実用上問題なし。
- 起動完了通知などの長時間処理は `ctx.waitUntil()` で実装 (これは別予算で 30 秒許容)。
- **緩和策**: CPU 時間を意識した実装 (重い JSON parse は KV キャッシュで回避)。万が一超えても $5/月で 3000 倍に拡張可能。

#### 4. AWS ネイティブツールの恩恵が薄い

- AWS SDK v3 を Workers 上で使うとバンドルサイズが大きい (1MB 超)。
- `aws4fetch` (5KB) で代替するが、SDK のエラーハンドリングや retry 機能を自前実装する必要。
- **緩和策**:
  - 呼び出す AWS API は EC2/EBS/S3 の数個に限定 → 薄いラッパーで十分
  - retry は exponential backoff を共通ライブラリ化 (`workers/shared/aws/`)
  - エラー時は Discord に直接通知 (sentry 等不要)

#### 5. ローカル開発体験のばらつき

- `wrangler dev` は本物の Workers ランタイムに近いが、KV や Secrets はモック扱い。
- AWS API 呼び出しもローカルからだと本物の AWS を叩くため、検証用環境分離が必要。
- **緩和策**: 検証用 AWS アカウント (or 専用 IAM ユーザー + リソースタグで隔離) を Phase 1 で用意。

#### 6. Cloudflare 障害時に全停止

- Workers が落ちると Discord 経由の全操作が不能。
- AWS Lambda + API GW でも同様 (AWS リージョン障害)。
- **緩和策**: Cloudflare の SLA は 99.99%、過去の大規模障害も年 1〜2 回程度。停止できない要件ではないため許容。

### 中立 (どちらでも同じ)

- セキュリティ責任の所在は変わらない (秘密管理・最小権限は両方必要)
- 監視は CloudWatch (実行プレーン側) + Workers Logs で並列
- バックアップは AWS 側 (EBS Snapshot) で実装

## Alternatives Considered

### A. AWS Lambda + API Gateway

**却下理由**:
- コールドスタートが Discord 3 秒制約と相性が悪い
- Provisioned Concurrency を使えば回避できるが月 ¥1000+ かかり本末転倒
- Terraform 行数が増え、開発初期の試行錯誤コストが高い
- 月 ¥35 程度ではあるが、無料枠の余裕度で Workers に劣る

**残った優位点**: AWS SDK のフル機能利用、リージョン内で完結する設計の明快さ

### C. EC2 t4g.nano 常時稼働 + 自前 web サーバー

**却下理由**:
- 月 ¥500〜700 の常時費用 (t4g.nano spot で抑えても spot 中断が制御プレーンに波及)
- OS パッチ・セキュリティ運用が増える
- Discord webhook の TLS 証明書管理が必要 (Let's Encrypt 自動化はできるが運用負担)

**残った優位点**: 完全自前、外部依存が AWS のみ

### D. Discord Bot (gateway 接続) を自宅 PC 常駐

**却下理由**:
- 自宅 PC の常時稼働 = 電気代 + 不在時の信頼性
- 自宅 IP 露出、Discord の API リミット管理が必要
- 「家のサーバー」の延長で運用が属人化

**残った優位点**: 完全無料、レイテンシ最小

## Migration Path

採用後の進化を以下に想定。

### Phase 1 (Workers + IAM Access Key) — 現在の決定

- Workers 上で Discord bot を稼働
- AWS IAM Access Key を Workers Secrets に保存
- 最小権限 IAM ユーザー専用作成

### Phase 2 (Workers + OIDC AssumeRole)

- Cloudflare OIDC provider を AWS IAM Identity Provider に登録
- Workers が `env.AWS_OIDC_TOKEN` を取得 → `AssumeRoleWithWebIdentity` でテンポラリ認証情報取得
- 長期キー全廃

### Phase 3 (もし必要なら): Workers + Durable Objects

- 複数ゲーム同時起動など状態が KV では辛くなったら Durable Objects に移行
- 現状は不要

### 撤退戦略 (もし Workers が不採用になったら)

万一 Workers での運用が破綻した場合、以下の順で Lambda に移行可能:

1. `workers/shared/aws/` (aws4fetch ラッパ) を SDK 呼び出しに置換
2. Discord 受信ハンドラを API Gateway + Lambda に移植 (Worker のソースはほぼ流用可)
3. Workers KV → DynamoDB に置換 (スキーマは互換性確保しやすい)
4. Cron Triggers → EventBridge Scheduler に置換

ロックインは小さく、3〜5 日で移行可能と見込む。

## Decision Log

| 日付 | 出来事 |
|---|---|
| 2026-05-17 | 当初記事の Lambda 構成を採用予定 → ユーザーから「Cloudflare で削減できないか」の提案 → 比較検討 → Workers 採用決定 |

## References

- 元記事: https://zenn.dev/daikitchen/articles/ac794d03b9baf3 (Lambda 構成のベース)
- Cloudflare Workers Free Plan: https://developers.cloudflare.com/workers/platform/pricing/
- aws4fetch: https://github.com/mhart/aws4fetch
- Discord Interaction 3 秒制約: https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-callback-type
- Cloudflare OIDC for AWS: https://developers.cloudflare.com/workers/configuration/secrets/ (将来 Phase 2 で参照)
