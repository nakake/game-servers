#!/bin/bash
# sidecar image tar を AMI 内の固定パスに配置する。
# 起動時の cloud-init (user-data) が `docker load -i /var/lib/sidecar-image.tar` で読む
# (workers/discord-handler/src/lib/launcher/user-data.ts の Step 4.5)。
#
# `docker load` を AMI build 中に走らせない理由:
#   AMI snapshot に Docker storage 上の image layer が乗ると AMI サイズが ~50-100MB
#   膨らみ、各起動時に余計に EBS read を消費する。tar のまま置いて、起動時に load する
#   方が安く済む (tar = compressed layers のため snapshot 内圧縮が効きやすい)。

set -euxo pipefail

SRC="/tmp/sidecar-image.tar"
DST="/var/lib/sidecar-image.tar"

if [ ! -f "${SRC}" ]; then
  echo "[install-sidecar] ERROR: ${SRC} not found. Packer 'file' provisioner step failed?" >&2
  exit 1
fi

mkdir -p "$(dirname "${DST}")"
mv "${SRC}" "${DST}"
chmod 644 "${DST}"

# 確認: ファイルが残っているか + tar として valid か (壊れている場合はここで気付く)
file "${DST}"
ls -la "${DST}"
# `docker load` の dry-run は無いので、tar が `docker save` 由来である簡易確認だけ:
tar -tf "${DST}" | head -5 || {
  echo "[install-sidecar] ERROR: ${DST} is not a valid tar archive" >&2
  exit 1
}

echo "[install-sidecar] complete (${DST} placed)"
