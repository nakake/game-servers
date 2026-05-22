# CLAUDE.md

このリポジトリで作業する Claude Code 向けのガイド。

## このプロジェクトの目的

Discord コマンドから起動・停止できる、複数ゲーム対応の Spot 型ゲームサーバー基盤。
**制御プレーン = Cloudflare Workers、実行プレーン = AWS EC2 Spot**。

詳細は `docs/design.md` を参照。読まずに大きな変更をしないこと。

## ディレクトリ構成と責務

| パス | 役割 | 主な言語 |
|---|---|---|
| `docs/` | 設計書・運用手順・ADR | Markdown |
| `workers/` | Cloudflare Workers (Discord bot、AWS 呼び出し) | TypeScript |
| `infra/` | AWS リソース定義 | Terraform |
| `ami/` | EC2 AMI ビルド定義 | Packer (HCL) |
| `launcher/` | EC2 上で動くゲーム起動ロジック、sidecar | bash + TypeScript |
| `games/` | ゲーム別定義 (registry.json + config) | JSON, 各ゲームの設定形式 |
| `scripts/` | 開発・運用スクリプト | bash / TS |
| `.github/workflows/` | CI/CD | YAML |

## 重要な規約

### 命名

- ファイル名: **kebab-case** (`discord-handler.ts`)
- TypeScript 型・クラス: **PascalCase** (`GameDefinition`)
- 変数・関数: **camelCase**
- Terraform リソース: **snake_case**、プレフィックス `gs-`
- AWS タグ: `Project=game-servers`, `Game=<game_id>`, `Env=prod`

### 秘密情報

**絶対にコミットしてはいけないもの**:
- AWS Access Key / Secret
- Cloudflare API Token
- Discord Bot Token / Public Key
- RCON パスワード
- SSH 秘密鍵 (`.pem`)
- `.dev.vars` (Wrangler ローカル env)
- `terraform.tfvars` (具体値が入る方)

これらは:
1. **Workers**: `wrangler secret put <NAME>` で Cloudflare 側に置く
2. **AWS**: SSM Parameter Store SecureString に置く
3. **ローカル開発**: `.dev.vars` / `.env` に置き、両方 `.gitignore` 済み
4. **秘密の保管場所**: `.secrets/` ディレクトリ (gitignore 済み)

ファイル名のチェック: コミット前に `git status` で `.pem`, `.env`, `.dev.vars`, `tfvars` が含まれていないか必ず確認。

### ゲーム追加・変更

ゲーム別の設定は `games/<game_id>/` に閉じ込める:

```
games/atm11/
├─ registry.json          # ★ Workers KV に投入される定義 (source of truth)
├─ README.md              # ゲーム固有メモ
└─ config/                # サーバー設定ファイル一式
   ├─ server.properties
   └─ user_jvm_args.txt
```

`registry.json` を変更したら `node scripts/register-game.mjs <game_id>` で Cloudflare DNS / S3 config / Workers KV に一括反映する。`--dry-run` で副作用なしのプレビュー可。

Worker 側のコード(`workers/discord-handler/`) は **ゲーム名をハードコードしてはいけない**。すべて `registry.json` のスキーマに従って動くこと。

### Worker のコード

- Discord interaction は **3 秒以内に必ず応答**。重い処理は `ctx.waitUntil()` で後追い。
- AWS API 呼び出しは **`aws4fetch`** を使う(AWS SDK v3 は Workers 上では重い)。
- 状態は **Workers KV** に置く。DynamoDB は使わない(コスト + シンプルさ)。
- Cron Triggers の最小単位は 1 分。idle 検知のフォールバック用途で使う。

### Terraform

- `infra/modules/` は再利用可能な単位で、`infra/envs/<env>/` から呼び出す。
- `prod` 環境のみで開始、`dev` は当面作らない (コスト)。
- `terraform.tfstate` は **S3 backend** で remote 管理 (versioning + SSE-KMS)。ロックは DynamoDB ではなく **S3 ネイティブロック** (`use_lockfile`、TF 1.10+)。IaC 移行 Step 8 で設定済。
- `terraform.tfvars` はコミットしない、`terraform.tfvars.example` を置く。

### AMI

- AMI は **汎用一個** で全ゲーム対応。ゲーム別ロジックは `launcher/adapters/` に。
- AMI 再ビルドのタイミング: Docker / Java / launcher 変更時のみ。
- ゲーム設定変更は S3 sync で済むため AMI 再ビルド不要。

## よくある作業フロー

### 新ゲーム追加

1. `games/<new-game>/registry.json` を `games/_template/` からコピーして編集
2. `games/<new-game>/config/` にサーバー設定ファイルを配置
3. `games/<new-game>/README.md` に固有メモを書く
4. `node scripts/register-game.mjs <new-game>` で Cloudflare DNS 作成 + S3 config sync + Workers KV 投入
5. Discord で `/list` に出現することを確認 (autocomplete も `<new-game>` を候補に出す)
6. `/start <new-game>` で起動確認

### Worker のローカル開発

```
cd workers/discord-handler
pnpm install
pnpm dev          # wrangler dev、http://localhost:8787 で受け
```

Discord interaction を試すには `wrangler tail` で本番 Worker のログを見るのが早い。

### Terraform 変更

```
cd infra/envs/prod
terraform plan -out=tfplan
# diff を確認
terraform apply tfplan
```

`apply` の前に **必ず plan の diff を読む**。spot price や instance_type の変更は実費に直結する。

## やってはいけないこと

- ❌ ゲーム別ロジックを Worker のコードに散らす(registry 駆動を死守)
- ❌ Lambda + API Gateway に戻す(Workers で完結する設計)
- ❌ Elastic IP 取得(コスト + 起動毎に DNS 更新する設計と矛盾)
- ❌ EC2 を常時稼働(Spot + idle 停止が前提)
- ❌ `git add .` で全部ステージング(秘密ファイル混入リスク)
- ❌ AMI に秘密情報を焼き込む(SSM Parameter Store から取得する設計)
- ❌ ゲーム world データを Git で管理(EBS snapshot で管理)

## 関連ドキュメント

- `docs/design.md` — 全体設計、コスト試算、フェーズ計画
- `docs/runbook.md` — Phase 0 検証手順
- `docs/adr/` — 設計判断記録 (今後追加)
- `games/atm11/README.md` — ATM11 固有メモ

## 環境前提

- OS: Windows 11 (作業マシン) / Amazon Linux 2023 (EC2)
- Node.js: 22 LTS
- pnpm: 9.x
- Terraform: 1.10+
- Packer: 1.11+
- Wrangler: 3.x
- AWS CLI: v2
- AWS リージョン: `ap-northeast-1` (東京)
