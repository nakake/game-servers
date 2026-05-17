# game-servers

Discord コマンドから操作する、複数ゲーム対応の AWS Spot 型ゲームサーバー基盤。

## 概要

```
[Discord] → [Cloudflare Workers] → [AWS EC2 Spot] → ゲームサーバー
```

- **コスト**: 月 50 時間プレイで ¥700 / 月程度を目標
- **拡張**: 新ゲーム追加は `games/<game_id>/registry.json` 追加だけ
- **制御**: Discord スラッシュコマンドで起動・停止・状態確認

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 全体設計、アーキテクチャ、コスト試算、フェーズ計画 |
| [docs/runbook.md](docs/runbook.md) | Phase 0 (検証フェーズ) の手動構築手順 |
| [CLAUDE.md](CLAUDE.md) | リポジトリ作業規約 (Claude Code 用、人間も参照可) |

## 現在のステータス

- ✅ 設計ドキュメント完成
- ✅ モノレポ skeleton 作成済み
- ✅ Phase 0: AWS 上での ATM11 動作検証 (2026-05-17, 詳細は `docs/phase0-results.md`)
- ⏳ Phase 1: Worker + Discord bot 最小実装
- ⏳ Phase 2: ゲーム抽象化
- ⏳ Phase 3: 自動停止
- ⏳ Phase 4: IaC 化

## 対応ゲーム

| game_id | 名称 | ステータス |
|---|---|---|
| `atm11` | All The Mods 11 | 定義作成済み、検証待ち |

新ゲーム追加: `games/_template/` をコピー(Phase 2 以降)。

## クイックスタート (Phase 0 を進める場合)

`docs/runbook.md` を参照。所要 半日、費用 ¥100 以下。

## 開発環境

```bash
pnpm install        # 依存解決 (Phase 1 以降に意味を持つ)
```

詳細は `CLAUDE.md` を参照。

## ライセンス

private (非公開)
