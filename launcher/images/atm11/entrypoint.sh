#!/bin/bash
#
# entrypoint.sh — ATM11 container 起動スクリプト
#
# 役割:
#   1. server.properties に rcon 設定を ensure
#   2. eula.txt 同意
#   3. SIGTERM trap で rcon save-all → stop を発火 → java 終了を待機
#   4. java を auto-restart 排除した形で直接起動
#
# 必須環境変数:
#   NEOFORGE_VERSION — registry.json と一致 (例: 26.1.2.48-beta)
#   RCON_PORT        — RCON listen port (例: 25575)
#   RCON_PASSWORD    — RCON 認証パスワード (本番は SSM から cloud-init で注入)

set -euo pipefail

: "${NEOFORGE_VERSION:?must be set}"
: "${RCON_PORT:?must be set}"
: "${RCON_PASSWORD:?must be set}"

DATA_DIR=/data
PROPS="$DATA_DIR/server.properties"
EULA_FILE="$DATA_DIR/eula.txt"
UNIX_ARGS="$DATA_DIR/libraries/net/neoforged/neoforge/${NEOFORGE_VERSION}/unix_args.txt"
JVM_ARGS="$DATA_DIR/user_jvm_args.txt"

# ---- 前提チェック ----
if [ ! -f "$UNIX_ARGS" ]; then
  echo "[entrypoint] FATAL: NeoForge unix_args.txt not found at $UNIX_ARGS" >&2
  echo "[entrypoint] /data に NeoForge installer を実行済みの ATM11 配布物が bind mount されている必要があります。" >&2
  exit 1
fi
if [ ! -f "$JVM_ARGS" ]; then
  echo "[entrypoint] FATAL: $JVM_ARGS not found" >&2
  exit 1
fi

# ---- server.properties の rcon 設定を ensure ----
ensure_property() {
  local key=$1 val=$2
  if [ ! -f "$PROPS" ]; then
    echo "${key}=${val}" >> "$PROPS"
    return
  fi
  if grep -qE "^${key}=" "$PROPS"; then
    sed -i -E "s|^${key}=.*|${key}=${val}|" "$PROPS"
  else
    echo "${key}=${val}" >> "$PROPS"
  fi
}

ensure_property "enable-rcon" "true"
ensure_property "rcon.port" "$RCON_PORT"
ensure_property "rcon.password" "$RCON_PASSWORD"
ensure_property "broadcast-rcon-to-ops" "false"

# ---- EULA 同意 (registry.json で EULA=TRUE が来る前提) ----
if [ "${EULA:-FALSE}" = "TRUE" ] || [ "${EULA:-false}" = "true" ]; then
  printf "eula=true\n" > "$EULA_FILE"
fi

# ---- graceful stop trap ----
MC_PID=""
shutdown() {
  echo "[entrypoint] SIGTERM/SIGINT received, sending rcon save-all + stop"
  if [ -n "$MC_PID" ] && kill -0 "$MC_PID" 2>/dev/null; then
    /opt/scripts/rcon-stop.sh || {
      echo "[entrypoint] WARN: rcon-stop.sh failed, java will be killed by docker grace timeout"
    }
    # java の正常終了を待つ。docker stop --time に収まらなければ docker が SIGKILL する。
    wait "$MC_PID" 2>/dev/null || true
  fi
  echo "[entrypoint] shutdown complete"
}
trap shutdown SIGTERM SIGINT

# ---- MC 起動 (auto-restart 排除) ----
echo "[entrypoint] starting MC server (NeoForge ${NEOFORGE_VERSION})"
cd "$DATA_DIR"
java @user_jvm_args.txt @"$UNIX_ARGS" nogui &
MC_PID=$!
echo "[entrypoint] MC PID=$MC_PID"

# trap が走るためには wait をフォアグラウンドで実行する必要がある。
# bash は signal を受けたら trap を実行してから wait が EINTR で返る挙動。
wait "$MC_PID"
EC=$?
echo "[entrypoint] java exited with code $EC"
exit "$EC"
