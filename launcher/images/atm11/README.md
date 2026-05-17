# ATM11 Docker image

Phase 1 で作成。`ghcr.io/game-servers/atm11-server:26.1.2` の中身。

## 設計

詳細: [ADR 0002](../../../docs/adr/0002-mc-stop-flow-docker-ssm.md)

- **base**: `eclipse-temurin:25-jre-noble` (Java 25 公式)
- **graceful stop**: PID 1 = tini → entrypoint.sh の SIGTERM trap が `mcrcon save-all && stop` を発火 → java exit
- **bind volume**: mods/config/libraries/world は image に焼かず `/data` に bind mount
- **RCON**: container 内 `localhost:25575` のみ、外部公開しない

## ローカル検証手順 (Windows + Docker Desktop)

### 1. 前提

- Docker Desktop 起動中
- WSL2 backend、メモリ 12 GB 以上割り当て (`Settings → Resources → Advanced`)
- `F:/Games/minecraft/ATM/ATM11/` に Phase 0 検証で使った ATM11 一式 (mods, libraries 展開済み) が存在
- ポート 25565 がローカルで空いている

### 2. .env 作成

```powershell
cd F:\project\game_servers\launcher\images\atm11
Copy-Item .env.example .env
# .env を開いて RCON_PASSWORD を適当な値に書き換え
```

### 3. ビルド & 起動

```powershell
docker compose up --build
```

- 初回 build は 1〜2 分 (Java image pull + mcrcon ダウンロード)
- 起動ログに `Done (XX.XXXs)! For help, type "help"` が出れば成功
- Minecraft クライアントで `localhost:25565` に接続

### 4. graceful stop 確認

別ターミナルから:

```powershell
docker stop --time=60 atm11
```

container のログに以下の順で出力されることを確認:

```
[entrypoint] SIGTERM/SIGINT received, sending rcon save-all + stop
Saved the game (mcrcon の出力)
Stopping the server
ThreadedAnvilChunkStorage: All dimensions are saved
[entrypoint] java exited with code 0
[entrypoint] shutdown complete
```

`docker ps -a` で `Exited (0)` になっていれば成功。

### 5. world データの破損確認

```powershell
docker compose up
```

再起動して前回の続きが読み込めること、Minecraft クライアントで前回プレイ位置に居ることを確認。

## 注意

- **RCON_PASSWORD は .env で渡す**。`docker-compose.yml` には書かない、`.dev.vars` / `.env` は `.gitignore` 済み。
- **`F:/Games/...` の bind mount は Docker Desktop の File Sharing 設定で F: が許可されている必要あり** (`Settings → Resources → File sharing`)。
- **`stop_grace_period: 60s`** が `docker stop --time=60` のデフォルトと揃っている。短くすると save-all flush が間に合わない可能性。

## トラブルシュート

### `unix_args.txt not found`

`/data` に NeoForge installer 実行済みの ATM11 一式が bind mount されていない。Phase 0 検証で `bash startserver.sh` を 1 回走らせて `libraries/` が展開されている状態であること。

### `docker stop` で 60 秒待っても落ちない

- entrypoint のログを確認: `SIGTERM received` が出ているか
- 出ていれば rcon 経路の問題: `mcrcon -H localhost -P 25575 -p $RCON_PASSWORD list` を container 内から手動実行して確認
  ```powershell
  docker exec -it atm11 mcrcon -H 127.0.0.1 -P 25575 -p <PASSWORD> list
  ```
- 出ていない場合は signal forwarding の問題: tini が PID 1 になっているか `docker exec atm11 ps -ef` で確認

### Java OOM / 起動が遅い

- Docker Desktop の WSL2 メモリ割当が 12 GB 未満
- `user_jvm_args.txt` で `-Xmx10G` 指定なので、container は 10 GB + Java metaspace + Docker overhead で約 11〜12 GB 必要
