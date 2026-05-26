# ATM10 (All The Mods 10)

## 概要

- **Minecraft**: 1.21.1
- **Loader**: NeoForge 21.1.x (`NEOFORGE_VERSION` 空にして itzg に自動選択させる)
- **Java**: 21 (`itzg/minecraft-server:java21`)
- **Mod 数**: TBD (初回起動後に実測)

## 追加経緯

ATM11 を母体とした **「既存流用」型** の新ゲーム追加事例 (Phase 6 ドッグフード)。
adapter / sidecar / AMI は ATM11 と共有し、`games/atm10/` 配下と SSM Parameter
だけ追加する形で運用できることを実証する。

差分は **MC/NeoForge バージョン、container image、(可能性として) JVM heap / instance type** のみ。
ports / idle_check (RCON) / ebs_size_gb / spot 上限は ATM11 から流用。

## インスタンス選定

`instance_types` は当初 ATM11 と同一 (r7a.large / r6a.large / m7a.xlarge) で開始。
ATM10 の mod 数・RSS が ATM11 より大きければ heap と instance を再評価する。

| 順位 | インスタンス | vCPU | RAM | spot 単価目安 |
|---|---|---|---|---|
| 1 | r7a.large | 2 | 16 GB | ¥6/h |
| 2 | r6a.large | 2 | 16 GB | ¥5/h |
| 3 | m7a.xlarge | 4 | 16 GB | ¥9/h |

## JVM 引数

ATM11 と同じ Generational ZGC + 10G 固定で開始。実測後に調整。

```
-Xms10G
-Xmx10G
-XX:+UseZGC
-XX:+AlwaysPreTouch
-XX:+DisableExplicitGC
-XX:-OmitStackTraceInFastThrow
-XX:+UnlockExperimentalVMOptions
```

## Docker イメージ

`itzg/minecraft-server:java21` を pull (image_source=pull)。

ATM11 は Java 25 要件のため自前ビルドだったが、ATM10 は Java 21 で済むので
itzg 公式 image をそのまま使う。これが「既存流用」型の最大のコスト削減ポイント。

NeoForge バージョンを固定したくなった場合は `env.NEOFORGE_VERSION` に
`21.1.95` 等の具体値を入れる。

## SSM Parameter

- `/gs/atm10/rcon_password` (SecureString) — 新規作成が必要

## 関連ファイル

- `registry.json` — ゲーム定義 (Workers KV のソース)
- `config/server.properties` — サーバー設定 (ATM11 から派生)
- `config/user_jvm_args.txt` — JVM 引数 (ATM11 と同等)
