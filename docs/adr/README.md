# Architecture Decision Records (ADR)

このディレクトリは設計上の重要な判断を記録する。
**「なぜそうしたか」** を後から追えるようにするのが目的。コードを読んでも分からない理由はここに書く。

## 書き方

- ファイル名: `NNNN-kebab-case-title.md` (連番)
- 1 つの判断 = 1 ファイル
- 一度 Accepted になった ADR は **書き換えない**。覆す場合は新しい ADR を作り、旧 ADR の Status を `Superseded by NNNN` に更新する。

## テンプレート

```markdown
# ADR NNNN: タイトル

- **Status**: Proposed | Accepted | Rejected | Superseded by NNNN | Deprecated
- **Date**: YYYY-MM-DD
- **Deciders**: 名前
- **Related**: 関連 ADR / 設計書セクション

## Context
何を決める必要があるか。背景・要件・制約。

## Decision
どう決めたか。実装方針も含めて簡潔に。

## Consequences
### Positive
良くなること

### Negative / Trade-off
悪くなること + 緩和策

## Alternatives Considered
検討した他の選択肢と却下理由

## References
参考文献・記事
```

## 索引

| ADR | タイトル | Status |
|---|---|---|
| [0001](0001-cloudflare-workers-over-lambda.md) | 制御プレーンに Cloudflare Workers を採用する | Accepted |
| [0002](0002-mc-stop-flow-docker-ssm.md) | MC サーバーの停止フローを Docker + SSM Run Command で構成する | Accepted |
