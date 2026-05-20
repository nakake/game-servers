// EC2 起動時の cloud-init script (user-data) 生成。
//
// Phase 1 hardcode 構成:
//   0. docker install (AL2023 は docker 同梱なし)
//   1. EBS volume (/dev/nvme1n1) を /opt/<game_id> に mount
//   2. S3 から launcher tarball (launcher/images/<game_id>.tar.gz) を取得して /opt/launcher/<game_id>/ に展開
//   3. SSM Parameter Store から RCON_PASSWORD を取得
//   4. docker build → docker run (image registry は使わず、EC2 で都度 build)
//
// Phase 4 で AMI に image を焼き込んで docker build を skip する想定。
//
// user-data は EC2 内で root として実行され、出力は /var/log/cloud-init-output.log に残る。

import type { GameDefinition } from '../registry/types.js';

export interface BuildUserDataOptions {
  game: GameDefinition;
  // launcher tarball を置く S3 URI (例: s3://gs-game-configs/launcher/atm11.tar.gz)
  launcherTarballS3Uri: string;
  // RCON password の SSM Parameter Store パス (例: /gs/atm11/rcon_password)
  rconPasswordSsmPath: string;
  // AWS リージョン
  awsRegion: string;
  // ready 通知用 SNS Topic ARN (未指定なら通知 step を skip)
  readyNotifySnsTopicArn?: string;
  // ready 通知に出す FQDN (例: atm11.example.com)
  fqdn?: string;
}

// /dev/sdf で attach した EBS は EC2 内で /dev/nvme1n1 として見える。
const EBS_DEVICE = '/dev/nvme1n1';

// MC 起動完了 polling のパラメータ。ATM11 初回ブートは mod ロードで 10 分超に
// なることがあるため余裕を持たせる (5s * 240 = 20 分)。
const READY_POLL_INTERVAL_SEC = 5;
const READY_POLL_COUNT = 240;

export function buildAtm11UserData(opts: BuildUserDataOptions): string {
  const { game, launcherTarballS3Uri, rconPasswordSsmPath, awsRegion, readyNotifySnsTopicArn, fqdn } = opts;
  const containerName = game.game_id;
  const dataDir = `/opt/${game.game_id}`;
  const launcherDir = `/opt/launcher/${game.game_id}`;
  const port = game.ports[0]?.port ?? 25565;
  const endpoint = fqdn !== undefined ? `${fqdn}:${port}` : `<public-ip>:${port}`;

  // env から container に渡す: registry.json の env を踏襲しつつ、
  // RCON_PASSWORD は SSM から動的取得した値を入れる。
  const envFromRegistry = Object.entries(game.env)
    .filter(([key]) => key !== 'RCON_PASSWORD_FROM_SSM') // SSM 参照 hint は container には渡さない
    .map(([key, value]) => `  -e ${shellEscape(key)}=${shellEscape(value)}`)
    .join(' \\\n');

  return `#!/bin/bash
set -euxo pipefail

LOG_FILE=/var/log/gs-userdata.log
exec > >(tee -a "$LOG_FILE") 2>&1

echo "[user-data] start: game=${game.game_id}"

# ---- 0. docker install + start (AL2023 は docker 同梱なし) ----
dnf install -y docker
systemctl enable --now docker
echo "[user-data] docker installed: $(docker --version)"

# ---- 1. EBS mount ----
mkdir -p ${dataDir}
# nvme1n1 は EC2 起動直後に attach 完了していない場合があるので待つ
for i in $(seq 1 30); do
  if [ -b ${EBS_DEVICE} ]; then break; fi
  echo "[user-data] waiting for ${EBS_DEVICE}..."
  sleep 2
done
# clean snapshot (filesystem on raw block device) と partitioned snapshot (root-volume 由来で
# /boot/efi が auto-mount される) の両方を扱えるように mount 対象を動的決定する。
# 過去の /stop バグで partition 入り snapshot 系統が混入したため。
if blkid ${EBS_DEVICE} > /dev/null 2>&1; then
  MOUNT_SRC=${EBS_DEVICE}
elif [ -b ${EBS_DEVICE}p1 ]; then
  MOUNT_SRC=${EBS_DEVICE}p1
  # auto-mount された /boot/efi (p128) を外しておかないと unmount 漏れで /stop 時に困る
  if mountpoint -q /boot/efi 2>/dev/null && [ "$(findmnt -n -o SOURCE /boot/efi)" = "${EBS_DEVICE}p128" ]; then
    umount /boot/efi || true
  fi
else
  echo "[user-data] no mountable filesystem on ${EBS_DEVICE}"
  exit 1
fi
mount $MOUNT_SRC ${dataDir}
echo "[user-data] mounted $MOUNT_SRC -> ${dataDir}"

# ---- 2. launcher tarball を S3 から取得 + 展開 ----
mkdir -p ${launcherDir}
aws s3 cp ${launcherTarballS3Uri} /tmp/launcher.tar.gz --region ${awsRegion}
tar -xzf /tmp/launcher.tar.gz -C ${launcherDir}
rm /tmp/launcher.tar.gz
echo "[user-data] launcher extracted to ${launcherDir}"
ls ${launcherDir}

# ---- 3. RCON_PASSWORD を SSM Parameter Store から取得 ----
RCON_PASSWORD=$(aws ssm get-parameter \\
  --name ${rconPasswordSsmPath} \\
  --with-decryption \\
  --region ${awsRegion} \\
  --query 'Parameter.Value' \\
  --output text)
echo "[user-data] RCON_PASSWORD fetched from SSM (length=\${#RCON_PASSWORD})"

# ---- 4. docker build + run ----
cd ${launcherDir}
docker build -t ${containerName}-server:dev .
echo "[user-data] image built"

docker run -d \\
  --name ${containerName} \\
  --stop-signal=SIGTERM \\
  --stop-timeout=60 \\
  -p ${port}:${port}/tcp \\
  -v ${dataDir}:/data \\
${envFromRegistry} \\
  -e RCON_PASSWORD="$RCON_PASSWORD" \\
  --restart=no \\
  ${containerName}-server:dev
echo "[user-data] container started"

# ---- 5. ready 検知 (container log で MC 起動完了行を polling) ----
${readyNotifySnsTopicArn !== undefined ? `
# docker run -p はホスト側ポートを即 bind するため /dev/tcp での port 検知は
# docker-proxy に当たって false positive になる (MC 本体が未起動でも accept される)。
# Forge/NeoForge が起動完了時に出力する 'Done (...)! For help' 行を container log
# から検知する。
echo "[user-data] waiting for MC server to finish loading"
for i in $(seq 1 ${READY_POLL_COUNT}); do
  if docker logs ${containerName} 2>&1 | grep -q 'Done ('; then
    echo "[user-data] MC server ready (after \${i} polls)"
    aws sns publish \\
      --topic-arn ${readyNotifySnsTopicArn} \\
      --subject "${game.game_id} ready" \\
      --message "✅ ${game.display_name} 接続可能になりました: \\\`${endpoint}\\\`" \\
      --region ${awsRegion} || echo "[user-data] sns publish failed (non-fatal)"
    break
  fi
  # container が ready 前に停止したら polling を打ち切る (mod クラッシュ / OOM 等)
  if [ "$(docker inspect -f '{{.State.Running}}' ${containerName} 2>/dev/null)" != "true" ]; then
    echo "[user-data] container ${containerName} stopped before becoming ready; abort ready wait"
    break
  fi
  sleep ${READY_POLL_INTERVAL_SEC}
done
` : `# ready 通知 skip (SNS topic ARN 未指定)`}
`;
}

// shell 用エスケープ (single-quoted 文字列に埋め込む)。
function shellEscape(value: string): string {
  // single quote で wrap、内部の ' は '\'' に置換
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// user-data を base64 化する (RunInstances の UserData は base64 要求)。
// btoa() は Latin1 のみ扱えるので、UTF-8 → Latin1 binary string 経由で encode する (日本語混入対策)。
export function base64EncodeUserData(userData: string): string {
  const bytes = new TextEncoder().encode(userData);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}
