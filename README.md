# game-servers

Discord コマンドから操作する、複数ゲーム対応の AWS Spot 型ゲームサーバー基盤。本番稼働中の個人プロジェクト。

## 概要

```
[Discord] → [Cloudflare Workers] → [AWS EC2 Spot] → ゲームサーバー
```

- **制御プレーン**: Cloudflare Workers (Discord interaction、AWS 操作、ゲーム registry、KV 状態管理)
- **実行プレーン**: AWS EC2 Spot (Launch Template + 起動時 user-data でゲーム別差を吸収、停止時は EBS snapshot 化)
- **認証**: Worker 自身を OIDC issuer 化し、AWS は `AssumeRoleWithWebIdentity` で 15min 短期 credentials を発行 (長期 IAM Access Key 不使用)
- **自動停止**: sidecar コンテナがゲームの idle (例: Minecraft RCON で人数 0) を検知 → Worker に通知 → EC2 terminate + snapshot
- **拡張**: 新ゲーム追加は `games/<game_id>/registry.json` の追加だけ。Worker コードはゲーム名をハードコードしない (registry 駆動)
- **コスト**: 月 50 時間プレイで ¥700 / 月程度を目標

## ステータス

| Phase | 内容 | 状態 |
|---|---|---|
| Phase 0 | AWS 上での ATM11 動作検証 | ✅ 完了 (`docs/phase0-results.md`) |
| Phase 1 | Worker + Discord bot 最小実装 | ✅ 完了 |
| Phase 2 | ゲーム抽象化 (registry 駆動) | ✅ 完了 |
| Phase 3 | 自動停止 (sidecar + idle 検知) | ✅ 完了 |
| Phase 4 | 通知 (SNS → Discord 集約、Spot 中断、コスト Budget) | ✅ 完了 |
| Phase 5 | IaC 化 + Worker OIDC (静的 AWS key 廃止) | ✅ 完了 |
| Phase 6 | 友人公開 / 新ゲーム追加実証 | 進行中 |

## 対応ゲーム

| game_id | 名称 | 状態 |
|---|---|---|
| `atm11` | All The Mods 11 (Minecraft NeoForge) | 本番稼働中 |

新ゲームを足すときは `games/_template/` をコピーして `registry.json` を編集 → `node scripts/register-game.mjs <id>` で Cloudflare DNS / S3 config / Workers KV に一括反映。Worker / AMI の再ビルドは不要。

## ドキュメント

| 区分 | ファイル | 内容 |
|---|---|---|
| 設計 | [docs/design.md](docs/design.md) | 全体設計、アーキテクチャ、コスト試算、Phase 計画 |
| 設計 | [docs/architecture.html](docs/architecture.html) | 構成図 (SVG、ブラウザで開く) |
| ADR | [docs/adr/0001](docs/adr/0001-cloudflare-workers-over-lambda.md) | Cloudflare Workers を Lambda より優先した理由 |
| ADR | [docs/adr/0002](docs/adr/0002-mc-stop-flow-docker-ssm.md) | MC 停止フローを Docker + SSM で実装する判断 |
| 計画 | [docs/iac-migration-plan.md](docs/iac-migration-plan.md) | 手動コンソール → Terraform 移行の Step 0〜8 |
| 計画 | [docs/phase2-plan.md](docs/phase2-plan.md) 〜 [phase5-plan.md](docs/phase5-plan.md) | 各 Phase の実装計画と決定記録 |
| 運用 | [docs/runbook.md](docs/runbook.md) | Phase 0 検証手順 |
| 運用 | [docs/runbook-phase1.md](docs/runbook-phase1.md) / [-phase1-production.md](docs/runbook-phase1-production.md) | Phase 1 ローカル開発 / 本番デプロイ |
| 運用 | [docs/runbook-phase3-sidecar.md](docs/runbook-phase3-sidecar.md) | Sidecar + AMI 構築手順 |
| 運用 | [docs/runbook-phase4-notifications.md](docs/runbook-phase4-notifications.md) | SNS 通知経路の構築 |
| 運用 | [docs/runbook-phase5-oidc.md](docs/runbook-phase5-oidc.md) | OIDC cutover / 鍵 rotation / 緊急対応 |
| 検証 | [docs/phase0-results.md](docs/phase0-results.md) | Phase 0 計測結果 (起動時間 / TPS / mspt / RSS) |
| 規約 | [CLAUDE.md](CLAUDE.md) | リポジトリ作業規約 (命名・秘密情報・やってはいけないこと) |

## ディレクトリ構成

| パス | 役割 | 主な言語 |
|---|---|---|
| `docs/` | 設計書・運用手順・ADR | Markdown |
| `workers/` | Cloudflare Workers (Discord bot、AWS 呼び出し、OIDC issuer) | TypeScript |
| `infra/` | AWS リソース定義 | Terraform |
| `ami/` | EC2 AMI ビルド定義 (Sidecar 同梱) | Packer (HCL) |
| `launcher/` | ゲームコンテナ Dockerfile + sidecar | bash / TypeScript |
| `games/` | ゲーム別定義 (registry.json + config) | JSON / 各ゲーム固有 |
| `scripts/` | 開発・運用スクリプト (ゲーム登録、OIDC 鍵生成、AMI ビルド等) | bash / TS / PowerShell |

## 開発環境

- Node.js 22 LTS / pnpm 9.x / Terraform 1.10+ / Packer 1.11+ / Wrangler 3.x / AWS CLI v2
- AWS リージョン: `ap-northeast-1`

```bash
pnpm install
pnpm --filter discord-handler test    # Worker ユニットテスト (115 件)
```

ローカル動作には `workers/discord-handler/wrangler.toml` / `infra/envs/prod/{backend,tfstate,network,variables}.tf` / `games/atm11/registry.json` に書かれている placeholder を実値に置き換える必要があります (個人環境の値を public 公開しないため placeholder 化済み)。

## ライセンス

[MIT License](LICENSE)

ゲームの world データや Discord bot の認証情報はリポジトリに含まれていないため、fork して自分の AWS / Discord App にデプロイしても本リポジトリ運営者の本番には一切影響しません。

---

このプロジェクトは [Claude Code](https://claude.com/claude-code) (Anthropic) の支援を受けて開発しました。
