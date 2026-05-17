#!/bin/bash
#
# rcon-stop.sh — MC サーバーを RCON 経由で graceful stop
#
# 呼び出し元: entrypoint.sh の trap (SIGTERM 受信時)
# 動作:
#   1. save-all flush で world を永続化
#   2. stop でサーバープロセスに停止指示
# どちらも localhost への RCON 接続。container 内で完結。

set -euo pipefail

: "${RCON_PORT:?}"
: "${RCON_PASSWORD:?}"

mcrcon -H 127.0.0.1 -P "$RCON_PORT" -p "$RCON_PASSWORD" \
  "save-all flush" \
  "stop"
