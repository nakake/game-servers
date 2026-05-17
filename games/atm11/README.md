# ATM11 (All The Mods 11)

## 概要

- **Minecraft**: 1.21.x 系 (NeoForge 26.1.2 ベース)
- **Loader**: NeoForge 26.1.2.48-beta
- **Java**: **25 必須** (NeoForge 26 系要件)
- **Mod 数**: 約 166 個 / 347 MB

## 性能設計値

Phase 0 検証 (2026-05-17, m7a.xlarge 実測) に基づく確定値:

| 項目 | 値 | 根拠 |
|---|---|---|
| JVM Heap (Xms/Xmx) | **10 GB 固定** | RSS 実測 11.06 GB、ZGC 推奨ヒープサイズ |
| GC | **Generational ZGC** | Java 23+ デフォルト、Allocation stall 無し確認 |
| 起動時間 | **44 秒** | ModernFix 計測値 |
| TPS (1 人プレイ) | **20.0** | 完璧 |
| mspt 中央値 | **5.0 ms** | 目標 50ms の 1/10 |
| CPU 使用率 | **3 %** | m7a.xlarge では完全に過剰 |
| 実 RAM 消費 | **11 GB** | OS + Docker 合わせて 14 GB 弱 |

## インスタンス選定

`instance_types` (EC2 Fleet 優先順):

| 順位 | インスタンス | vCPU | RAM | spot 単価目安 | 月50h | 採用理由 |
|---|---|---|---|---|---|---|
| **1** | **r7a.large** | **2** | **16 GB** | **¥6/h** | **¥300/月** | **CPU 余り、RAM 必要、AMD 最新世代で最安** |
| 2 | r6a.large | 2 | 16 GB | ¥5/h | ¥250/月 | Graviton 不可 (Java 25 / mod 互換懸念のため AMD)、旧世代 fallback |
| 3 | m7a.xlarge | 4 | 16 GB | ¥9/h | ¥450/月 | Phase 0 で実績あり、spot 中断時の最終 fallback |

> **r7a.large に絞った理由**: Phase 0 で m7a.xlarge の CPU 使用率がわずか **3%** だった。
> 4 vCPU は完全にオーバースペック。vCPU 半減・単価 -33% でも問題なく動く想定。
> 3〜4 人プレイ + mob 農場稼働でも CPU 余裕は十分残る計算。

### 除外したインスタンス

| インスタンス | 除外理由 |
|---|---|
| t4g.* / t3.* | バースト型 = 長時間安定稼働に不向き |
| m7a.large | RAM 8GB で Xmx 10G + ZGC オーバーヘッドに不足 |
| r7g.large | Graviton (ARM) — mod 一部に native lib 互換性懸念 |
| c7a.large | RAM 4GB で論外 |

### スポット価格上限

`spot_max_price_jpy_per_hour: 12` — r7a.large の通常 spot 単価の 2 倍を上限に設定。スパイク時の極端な高騰を防ぎつつ、稀な高値帯でも起動可能なバランス。

## 入っている主な性能 mod

- FerriteCore 9.0.0
- ModernFix 5.27.11
- spark (profiler)

> Saturn / Canary / NoisiumNeo は **NeoForge 26.1.2 対応版が未リリース**(2026-05 時点)。
> 対応版が出たら `mods/` に追加するだけで効く想定。

## JVM 引数

```
-Xms10G
-Xmx10G
-XX:+UseZGC
-XX:+AlwaysPreTouch
-XX:+DisableExplicitGC
-XX:-OmitStackTraceInFastThrow
-XX:+UnlockExperimentalVMOptions
```

ZGC は Generational がデフォルトのため `-XX:+ZGenerational` は不要。
旧 G1GC 設定 (Aikar's flags) は `config/user_jvm_args.aikar.bak` に退避してある。

## server.properties 重要設定

| key | value | 理由 |
|---|---|---|
| view-distance | 8 | tick 負荷削減 |
| simulation-distance | 5 | 同上、これ以下は機械系 mod に影響 |
| max-players | 20 | RAM 余裕分 |
| pause-when-empty-seconds | 60 | 0人時の CPU 削減 |
| enable-rcon | true | sidecar の idle 検知に必須 |

## Docker イメージ

`ghcr.io/game-servers/atm11-server:26.1.2` (自前ビルド予定)

itzg/minecraft-server に `:java25` タグが揃うまでは自前で:

```dockerfile
FROM eclipse-temurin:25-jre
# + NeoForge installer + mods 一式
```

Dockerfile は `launcher/images/atm11/` 配下に配置(Phase 1 で作成)。

## 既知の課題

- **Spot 中断時のセーブ**: NeoForge の `/save-all flush` 完了に 10〜30 秒かかるケースあり。
  Spot interruption notice の 2 分以内に間に合うか Phase 0 で検証。
- **チャンクロード時のスパイク**: 新規エリア踏破時に mspt が 100ms 超えることあり。
  プレジェネで対応予定(Phase 4 以降)。

## 関連ファイル

- `registry.json` — ゲーム定義(Workers KV に投入されるソース)
- `config/user_jvm_args.txt` — JVM 引数
- `config/server.properties` — サーバー設定
