#!/usr/bin/env bash
# Cloudflare Worker の TLS cert chain から SHA-1 fingerprint を取得して Terraform
# の thumbprint_list 形式 (colon なし lowercase hex 40 桁) で出力する。
#
# 詳細: docs/phase5-plan.md Step 2、infra/modules/aws-oidc-cloudflare/README.md
#
# 使い方:
#   ./scripts/get-cf-thumbprint.sh discord-handler.<your-account>.workers.dev
#
# 出力例:
#   leaf:         a1b2c3...
#   intermediate: 9deb1d... (こちらを Terraform thumbprints に渡すと cert 更新時の影響が小さい)
#
# AWS は cert chain 内の任意の SHA-1 を受け付けるため、intermediate (Cloudflare Inc ECC CA-3 等) を
# 使うと leaf 証明書のローテーションで毎回 thumbprint 更新する必要がなくなる。

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <host>" >&2
  echo "Example: $0 discord-handler.<your-account>.workers.dev" >&2
  exit 1
fi

HOST=$1

# cert chain を取得 (-showcerts は全 cert を PEM で出力)。
CHAIN=$(echo | openssl s_client -servername "$HOST" -showcerts -connect "$HOST:443" 2>/dev/null \
  | awk '/-----BEGIN CERTIFICATE-----/{flag=1} flag{print} /-----END CERTIFICATE-----/{flag=0; print "---SPLIT---"}')

# --- SPLIT --- 区切りで分解、各 cert の SHA-1 fingerprint を取得。
INDEX=0
echo "$CHAIN" | awk -v RS='---SPLIT---' 'NF>0' | while read -r CERT; do
  FP=$(echo "$CERT" | openssl x509 -fingerprint -sha1 -noout 2>/dev/null | sed 's/SHA1 Fingerprint=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')
  if [ -z "$FP" ]; then continue; fi
  case $INDEX in
    0) LABEL="leaf        " ;;
    1) LABEL="intermediate" ;;
    *) LABEL="cert #$INDEX     " ;;
  esac
  echo "$LABEL: $FP"
  INDEX=$((INDEX + 1))
done

echo "" >&2
echo "Terraform 投入: 上記いずれかの fingerprint を thumbprints = [\"...\"] に貼る" >&2
echo "推奨: 安定性の観点で intermediate (cert #1) を採用 (leaf は短期 rotation あり)" >&2
