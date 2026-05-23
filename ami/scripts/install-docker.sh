#!/bin/bash
# AL2023 base AMI に Docker Engine と Docker Compose v2 を入れる。
# Packer の shell provisioner が sudo で呼ぶ。
#
# memory: AL2023 リポジトリに `docker-compose-plugin` パッケージは無い (2024 時点)。
# 公式 GitHub releases から binary を直接配置するのが運用パターン。

set -euxo pipefail

# 1. docker engine (AL2023 repo に同梱)
dnf install -y docker
systemctl enable docker

# 2. docker compose v2 (GitHub releases の Linux x86_64 binary を CLI plugin として配置)
COMPOSE_VERSION="v2.32.4"
COMPOSE_PATH="/usr/libexec/docker/cli-plugins/docker-compose"
mkdir -p "$(dirname "${COMPOSE_PATH}")"
curl -fsSL -o "${COMPOSE_PATH}" \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64"
chmod +x "${COMPOSE_PATH}"

# 3. ec2-user を docker グループに (ssh ログイン時 sudo なしで docker 使えるように)
usermod -aG docker ec2-user

# 4. 確認: Packer のログに version が出ることで動作確認
docker --version
"${COMPOSE_PATH}" version

echo "[install-docker] complete"
