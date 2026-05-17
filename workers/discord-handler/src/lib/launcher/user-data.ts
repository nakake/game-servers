// EC2 起動時の cloud-init script (user-data) 生成。
//
// Phase 1 hardcode 構成:
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
}

// /dev/sdf で attach した EBS は EC2 内で /dev/nvme1n1 として見える。
const EBS_DEVICE = '/dev/nvme1n1';

export function buildAtm11UserData(opts: BuildUserDataOptions): string {
  const { game, launcherTarballS3Uri, rconPasswordSsmPath, awsRegion } = opts;
  const containerName = game.game_id;
  const dataDir = `/opt/${game.game_id}`;
  const launcherDir = `/opt/launcher/${game.game_id}`;
  const port = game.ports[0]?.port ?? 25565;

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

# ---- 1. EBS mount ----
mkdir -p ${dataDir}
# nvme1n1 は EC2 起動直後に attach 完了していない場合があるので待つ
for i in $(seq 1 30); do
  if [ -b ${EBS_DEVICE} ]; then break; fi
  echo "[user-data] waiting for ${EBS_DEVICE}..."
  sleep 2
done
mount ${EBS_DEVICE} ${dataDir}
echo "[user-data] mounted ${EBS_DEVICE} -> ${dataDir}"

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
`;
}

// shell 用エスケープ (single-quoted 文字列に埋め込む)。
function shellEscape(value: string): string {
  // single quote で wrap、内部の ' は '\'' に置換
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Workers Runtime の btoa を使って user-data を base64 化する (RunInstances の UserData は base64 要求)。
export function base64EncodeUserData(userData: string): string {
  return btoa(userData);
}
