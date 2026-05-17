# ATM11 (All The Mods 11)

## 概要

- **Minecraft**: 1.21.x 系 (NeoForge 26.1.2 ベース)
- **Loader**: NeoForge 26.1.2.48-beta
- **Java**: **25 必須** (NeoForge 26 系要件)
- **Mod 数**: 約 166 個 / 347 MB

## 性能設計値

| 項目 | 値 |
|---|---|
| JVM Heap (Xms/Xmx) | 10 GB (固定) |
| GC | Generational ZGC (Java 23+ デフォルト) |
| インスタンス第一候補 | m7a.xlarge (4 vCPU / 16 GB) |
| 想定実 RAM 消費 | 12〜14 GB |
| 想定 mspt | < 50ms (1〜3 人) |
| 想定起動時間 | 40〜60 秒 |

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
