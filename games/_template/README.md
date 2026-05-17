# Game Definition Template

新しいゲームを追加するときの雛形。`_template` ディレクトリを丸ごとコピーして使う。

## 手順

```bash
# 1. テンプレをコピー (例: terraria 追加)
cp -r games/_template games/terraria

# 2. registry.json の REPLACE_ME を実値に書き換え
#    game_id, display_name, subdomain, ports, container_image, env など

# 3. enabled: false → true (動作確認後)

# 4. ゲーム固有の設定ファイルを config/ に配置
#    例: server.properties, user_jvm_args.txt, serverconfig.txt 等

# 5. README.md を上書きしてゲーム固有メモを書く

# 6. Cloudflare DNS にサブドメインを作成 (手動 or scripts/register-game.sh)
#    A レコード作成 → record_id を registry.json の cf_record_id に貼る

# 7. Workers KV に registry を投入
#    scripts/register-game.sh <game_id>  ※Phase 2 で実装予定

# 8. Discord で /list に出現することを確認

# 9. /start <game_id> で起動確認
```

## フィールド一覧

### 基本

| フィールド | 型 | 例 | 説明 |
|---|---|---|---|
| `game_id` | string | `"atm11"` | 一意 ID。小文字英数 + ハイフン推奨。コマンド引数で使う |
| `display_name` | string | `"All The Mods 11"` | Discord での表示名 |
| `category` | enum | `"minecraft-modded"` | idle 検知アダプタの選択に使う(後述) |
| `enabled` | boolean | `true` | `false` だと Discord の `/list` に出ない |

### EC2 起動パラメータ

| フィールド | 型 | 例 | 説明 |
|---|---|---|---|
| `instance_types` | string[] | `["m7a.xlarge", "m6a.xlarge"]` | EC2 Fleet 候補。先頭優先。AZ 横断で中断率を下げる |
| `ebs_size_gb` | number | `30` | データ用 EBS サイズ |
| `spot_max_price_jpy_per_hour` | number\|null | `30` | spot 上限。null なら on-demand 価格まで許容 |

### ネットワーク

| フィールド | 型 | 例 | 説明 |
|---|---|---|---|
| `subdomain` | string | `"atm11"` | `<subdomain>.<your_domain>` で接続 |
| `cf_record_id` | string | `"abc123..."` | Cloudflare DNS API の record id。事前に A レコード作成して取得 |
| `ports` | array | `[{port: 25565, proto: "TCP"}]` | 開放ポートと protocol |

### ゲーム起動

| フィールド | 型 | 例 | 説明 |
|---|---|---|---|
| `container_image` | string | `"itzg/minecraft-server:java25"` | Docker イメージ。AMI に pull 済みでなくても可 |
| `env` | object | `{EULA: "TRUE", ...}` | コンテナの環境変数。`itzg/minecraft-server` の場合は公式 doc 参照 |
| `config_s3_prefix` | string | `"s3://gs-game-configs/atm11/"` | サーバー起動時に S3 から sync するゲーム設定 |

### idle 検知

| フィールド | 型 | 説明 |
|---|---|---|
| `idle_check.type` | enum | アダプタ種別 (後述) |
| `idle_check.timeout_min` | number | 0 人が何分続いたら停止するか |
| `idle_check.heartbeat_interval_sec` | number | sidecar が確認する頻度 (60 推奨) |
| `idle_check.config` | object | アダプタ固有の設定 |

### バックアップ

| フィールド | 型 | 説明 |
|---|---|---|
| `snapshot.generations` | number | 何世代保持するか (3 推奨) |
| `snapshot.weekly_s3_backup` | boolean | true で週次 S3 アーカイブ |
| `snapshot.tags` | object | EBS / Snapshot に付ける AWS タグ |

### Discord メッセージ

| フィールド | 用途 |
|---|---|
| `discord.start_message` | `/start` 受付直後の deferred response |
| `discord.ready_message` | 起動完了時の置換メッセージ |
| `discord.stop_message` | `/stop` 完了時のメッセージ |

## category と idle_check の組み合わせ

| category | 推奨 idle_check.type | config に必要 |
|---|---|---|
| `minecraft-vanilla` / `minecraft-modded` | `minecraft_rcon` | port, password_source, command, empty_pattern |
| `terraria` | `tshock_rest` | host, port, api_token_source |
| `valheim` | `steam_query` | host, query_port |
| `factorio` | `factorio_rcon` | host, port, password_source |

新カテゴリを追加する場合は `launcher/sidecar/src/adapters/` に新アダプタを実装する必要がある。

## よくある間違い

### ❌ container_image にバージョン無し

```json
"container_image": "itzg/minecraft-server"
```

→ `:latest` 扱いで予期せぬバージョン更新が起きる。**必ずタグ固定**。

### ❌ MEMORY を高く設定しすぎ

```json
"env": { "MEMORY": "12G" }
```

→ インスタンスタイプの RAM を超えると OOM。`instance_types` の最小 RAM の **70% 以下** に抑える。

### ❌ RCON password を平文で書く

```json
"env": { "RCON_PASSWORD": "hunter2" }
```

→ Git にコミットしてはいけない。**必ず `RCON_PASSWORD_FROM_SSM` で SSM 参照** にする。

### ❌ cf_record_id が "TBD_AFTER_REGISTRATION" のまま

→ DNS 更新が無効になり、起動しても接続できない。`scripts/register-game.sh` 実行後に必ず実値が入っているか確認。

## 参考: 既存ゲーム

- [`games/atm11/`](../atm11/) — Minecraft NeoForge modded の例
