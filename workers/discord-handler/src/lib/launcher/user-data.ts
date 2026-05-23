// EC2 起動時の cloud-init script (user-data) 生成。
//
// registry.json (GameDefinition) 駆動。ゲーム差は registry に閉じ、この関数は分岐するだけ:
//   - image_source "build": launcher tarball を S3 から取得し EC2 上で docker build
//   - image_source "pull" : container_image を docker pull
//   - seed snapshot 無しの初回起動 (formatBlankVolume): 空 EBS を mkfs.ext4 で初期化
//
// 構成:
//   0. docker install (AL2023 は docker 同梱なし)
//   1. EBS volume (/dev/nvme1n1) を /opt/<game_id> に mount (空なら mkfs)
//   2. コンテナイメージ準備 (build: tarball 取得 + docker build / pull: docker pull)
//   3. RCON_PASSWORD を SSM Parameter Store から取得 (registry env に SSM 参照があれば)
//   4. docker run
//   5. ready 検知 → SNS publish
//
// user-data は EC2 内で root として実行され、出力は /var/log/cloud-init-output.log に残る。

import type { GameDefinition } from '../registry/types.js';

export interface BuildUserDataOptions {
  game: GameDefinition;
  // AWS リージョン (aws CLI 呼び出し用)
  awsRegion: string;
  // snapshot 指定なし起動 = 空 EBS。true なら filesystem が無いとき mkfs.ext4 する。
  // start.ts が「復元元 snapshot 無し」と判断したときだけ true にする。
  formatBlankVolume: boolean;
  // ready 通知用 SNS Topic ARN (未指定なら通知 step を skip)
  readyNotifySnsTopicArn?: string;
  // ready 通知に出す FQDN (例: atm11.example.com)
  fqdn?: string;
  // Worker 自身の公開 URL (Phase 3: sidecar の WORKER_URL env)
  workerPublicUrl: string;
  // AMI 内に焼き込まれた sidecar image のタグ。省略時 'gs-sidecar:latest' (Packer の load 時タグ)。
  sidecarImage?: string;
}

// /dev/sdf で attach した EBS は EC2 内で /dev/nvme1n1 として見える。
const EBS_DEVICE = '/dev/nvme1n1';

// container (itzg/minecraft-server 系) が /data に書けるよう新規ボリュームを chown する uid。
const CONTAINER_UID = 1000;

// MC 起動完了 polling のパラメータ。modded の初回ブートは mod ロードで 10 分超に
// なることがあるため余裕を持たせる (5s * 240 = 20 分)。
const READY_POLL_INTERVAL_SEC = 5;
const READY_POLL_COUNT = 240;

// Phase 3: sidecar image のデフォルトタグ。Packer (Step 7) が `docker load` するときの tag。
const DEFAULT_SIDECAR_IMAGE = 'gs-sidecar:latest';
// AMI 内に同梱された sidecar の tar ファイル (Step 7 で Packer が配置)。
const SIDECAR_IMAGE_TAR_PATH = '/var/lib/sidecar-image.tar';

export function buildUserData(opts: BuildUserDataOptions): string {
  const {
    game,
    awsRegion,
    formatBlankVolume,
    readyNotifySnsTopicArn,
    fqdn,
    workerPublicUrl,
    sidecarImage = DEFAULT_SIDECAR_IMAGE,
  } = opts;
  // 末尾スラッシュは sidecar 側でも削るが、user-data 段階で正規化しておく。
  const normalizedWorkerUrl = workerPublicUrl.replace(/\/+$/, '');
  const containerName = game.game_id;
  const dataDir = `/opt/${game.game_id}`;
  const launcherDir = `/opt/launcher/${game.game_id}`;
  const port = game.ports[0]?.port ?? 25565;
  const endpoint = fqdn !== undefined ? `${fqdn}:${port}` : `<public-ip>:${port}`;

  // RCON password の SSM path。registry env の RCON_PASSWORD_FROM_SSM (SSM 参照 hint)。
  // 無いゲームは RCON 無しとして SSM 取得 step ごと skip する。
  const rconSsmPath = game.env.RCON_PASSWORD_FROM_SSM;

  // container に渡す env: registry.json の env を踏襲。RCON_PASSWORD_FROM_SSM は SSM 参照
  // hint なので container には渡さない (実値は SSM から取得して RCON_PASSWORD で渡す)。
  const envFromRegistry = Object.entries(game.env)
    .filter(([key]) => key !== 'RCON_PASSWORD_FROM_SSM')
    .map(([key, value]) => `  -e ${shellEscape(key)}=${shellEscape(value)}`)
    .join(' \\\n');

  const isBuild = game.image_source === 'build';
  // docker run で参照する image。build はローカルビルド tag、pull は registry の image。
  const imageRef = isBuild ? `${containerName}-server:dev` : game.container_image;
  // build モードのみ launcher tarball を使う。config_s3_prefix の bucket から導出する。
  const launcherTarballS3Uri = isBuild
    ? deriveLauncherTarballUri(game.config_s3_prefix, game.game_id)
    : '';

  return `#!/bin/bash
set -euxo pipefail

LOG_FILE=/var/log/gs-userdata.log
exec > >(tee -a "$LOG_FILE") 2>&1

echo "[user-data] start: game=${game.game_id} image_source=${game.image_source}"

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
if blkid ${EBS_DEVICE} > /dev/null 2>&1; then
  MOUNT_SRC=${EBS_DEVICE}
  FORMATTED=0
elif [ -b ${EBS_DEVICE}p1 ]; then
  MOUNT_SRC=${EBS_DEVICE}p1
  FORMATTED=0
  # auto-mount された /boot/efi (p128) を外しておかないと unmount 漏れで /stop 時に困る
  if mountpoint -q /boot/efi 2>/dev/null && [ "$(findmnt -n -o SOURCE /boot/efi)" = "${EBS_DEVICE}p128" ]; then
    umount /boot/efi || true
  fi
else
${
    formatBlankVolume
      ? `  # snapshot 指定なしの初回起動。空ボリュームを ext4 で初期化する。
  echo "[user-data] no filesystem on ${EBS_DEVICE} — formatting ext4 (first boot)"
  mkfs.ext4 -F ${EBS_DEVICE}
  MOUNT_SRC=${EBS_DEVICE}
  FORMATTED=1`
      : `  echo "[user-data] no mountable filesystem on ${EBS_DEVICE}"
  exit 1`
  }
fi
mount $MOUNT_SRC ${dataDir}
echo "[user-data] mounted $MOUNT_SRC -> ${dataDir}"
# 新規フォーマットしたボリュームは root 所有。container (uid ${CONTAINER_UID}) が
# /data に書けるよう chown する。snapshot 復元時は所有権を保持したいので触らない。
if [ "$FORMATTED" = "1" ]; then
  chown ${CONTAINER_UID}:${CONTAINER_UID} ${dataDir}
  echo "[user-data] chown ${dataDir} -> uid ${CONTAINER_UID} (new volume)"
fi

# ---- 2. コンテナイメージ準備 ----
${
    isBuild
      ? `# build: launcher tarball を S3 から取得 + 展開 → docker build
mkdir -p ${launcherDir}
aws s3 cp ${launcherTarballS3Uri} /tmp/launcher.tar.gz --region ${awsRegion}
tar -xzf /tmp/launcher.tar.gz -C ${launcherDir}
rm /tmp/launcher.tar.gz
echo "[user-data] launcher extracted to ${launcherDir}"
cd ${launcherDir}
docker build -t ${imageRef} .
echo "[user-data] image built: ${imageRef}"`
      : `# pull: registry の container_image を docker pull
docker pull ${game.container_image}
echo "[user-data] image pulled: ${game.container_image}"`
  }

# ---- 3. RCON_PASSWORD を SSM Parameter Store から取得 ----
${
    rconSsmPath !== undefined
      ? `RCON_PASSWORD=$(aws ssm get-parameter \\
  --name ${rconSsmPath} \\
  --with-decryption \\
  --region ${awsRegion} \\
  --query 'Parameter.Value' \\
  --output text)
echo "[user-data] RCON_PASSWORD fetched from SSM (length=\${#RCON_PASSWORD})"`
      : `echo "[user-data] no RCON_PASSWORD_FROM_SSM in registry — skip SSM fetch"`
  }

# ---- 4. docker run ----
docker run -d \\
  --name ${containerName} \\
  --stop-signal=SIGTERM \\
  --stop-timeout=60 \\
  -p ${port}:${port}/tcp \\
  -v ${dataDir}:/data \\
${envFromRegistry} \\
${rconSsmPath !== undefined ? '  -e RCON_PASSWORD="$RCON_PASSWORD" \\\n' : ''}  --restart=no \\
  ${imageRef}
echo "[user-data] container started"

# ---- 4.5. sidecar 起動 (Phase 3: idle 検知 + Worker への heartbeat) ----
# AMI 内に Packer が \`docker save\` した tar が同梱されている前提 (Step 7)。
# 初回起動時のみ load、以降は image cache が効くので idempotent。
if [ -f ${SIDECAR_IMAGE_TAR_PATH} ]; then
  docker load -i ${SIDECAR_IMAGE_TAR_PATH} || echo "[user-data] sidecar image load failed (proceeding, image may already exist)"
else
  echo "[user-data] sidecar tar not found at ${SIDECAR_IMAGE_TAR_PATH} — AMI may be pre-Step-7"
fi
# --network host で同 instance の game container の RCON (localhost:25575) にアクセスする。
# SSM secret / IMDSv2 取得は host network の link-local で sidecar 内部から直接呼ぶ。
docker run -d \\
  --name sidecar \\
  --network host \\
  --restart unless-stopped \\
  -e GAME_ID=${shellEscape(game.game_id)} \\
  -e WORKER_URL=${shellEscape(normalizedWorkerUrl)} \\
  -e AWS_REGION=${shellEscape(awsRegion)} \\
  ${sidecarImage} || echo "[user-data] sidecar docker run failed (non-fatal, fallback Cron will catch idle)"
echo "[user-data] sidecar started"

# ---- 5. ready 検知 (container log で MC 起動完了行を polling) ----
${
    readyNotifySnsTopicArn !== undefined
      ? `
# docker run -p はホスト側ポートを即 bind するため /dev/tcp での port 検知は
# docker-proxy に当たって false positive になる (MC 本体が未起動でも accept される)。
# Minecraft server (vanilla/Forge/NeoForge) が起動完了時に出力する 'Done (...)! For help'
# 行を container log から検知する。
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
`
      : `# ready 通知 skip (SNS topic ARN 未指定)`
  }
`;
}

// config_s3_prefix (例: s3://gs-game-configs/atm11/) の bucket を取り出し、
// launcher tarball の URI s3://<bucket>/launcher/<game_id>.tar.gz を組み立てる。
function deriveLauncherTarballUri(configS3Prefix: string, gameId: string): string {
  const match = /^s3:\/\/([^/]+)\//.exec(configS3Prefix);
  if (match === null || match[1] === undefined) {
    throw new Error(`cannot derive S3 bucket from config_s3_prefix: ${configS3Prefix}`);
  }
  return `s3://${match[1]}/launcher/${gameId}.tar.gz`;
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
