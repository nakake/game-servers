# Game Definition Template

新しいゲームを追加するときの雛形。`_template` ディレクトリを丸ごとコピーして使う。

## 手順

```bash
# 1. テンプレをコピー (例: terraria 追加)
cp -r games/_template games/terraria

# 2. registry.json の REPLACE_ME を実値に書き換え
#    game_id, display_name, subdomain, ports, container_image, image_source, env など
#    (cf_record_id は register-game.mjs が自動で埋めるので TBD のままでよい)

# 3. ゲーム固有の設定ファイルを config/ に配置
#    例: server.properties, user_jvm_args.txt, serverconfig.txt 等

# 4. README.md を上書きしてゲーム固有メモを書く

# 5. RCON password を SSM Parameter Store に登録 (minecraft 系)
#    /gs/<game_id>/rcon_password を SecureString で作成

# 6. register-game.mjs で DNS レコード作成 + config の S3 sync + KV 投入を一括反映
#    CLOUDFLARE_DNS_API_TOKEN=xxx node scripts/register-game.mjs <game_id>

# 7. 動作確認できたら registry.json の enabled を true にして再度 register-game.mjs

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
| `seed_snapshot_id` | string\|null | `null` | 初回起動の種 snapshot。新規ゲームは `null`(空 EBS を `mkfs` して起動)。以降は `/stop` が作る snapshot が自動で使われる |
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
| `image_source` | enum | `"pull"` | `"pull"`=`container_image` を `docker pull`(公開イメージで完結)/ `"build"`=`launcher/images/<id>/` を S3 経由で取得し EC2 で `docker build`(自前イメージ) |
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

→ DNS 更新が無効になり、起動しても接続できない。`scripts/register-game.mjs` 実行後に必ず実値が入っているか確認。

## 参考: 既存ゲーム

- [`games/atm11/`](../atm11/) — Minecraft NeoForge modded の例
