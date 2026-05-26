import { describe, expect, it } from 'vitest';

import type { GameDefinition } from '../registry/types.js';
import { buildUserData } from './user-data.js';

// テスト用の最小 GameDefinition。buildUserData が参照するフィールドのみ埋める。
function makeGame(overrides: Partial<GameDefinition> = {}): GameDefinition {
  return {
    game_id: 'atm11',
    display_name: 'All The Mods 11',
    category: 'minecraft-modded',
    enabled: true,
    instance_types: ['r7a.large'],
    ebs_size_gb: 30,
    spot_max_price_jpy_per_hour: 12,
    subdomain: 'atm11',
    cf_record_id: 'rec-1234',
    ports: [{ port: 25565, proto: 'TCP' }],
    container_image: 'ghcr.io/game-servers/atm11-server:26.1.2',
    image_source: 'build',
    env: {
      EULA: 'TRUE',
      TYPE: 'NEOFORGE',
      RCON_PASSWORD_FROM_SSM: '/gs/atm11/rcon_password',
    },
    config_s3_prefix: 's3://gs-game-configs/atm11/',
    idle_check: {
      type: 'minecraft_rcon',
      timeout_min: 10,
      heartbeat_interval_sec: 60,
      config: {},
    },
    snapshot: { generations: 3, weekly_s3_backup: true },
    discord: {
      start_message: 'starting',
      ready_message: 'ready',
      stop_message: 'stopped',
    },
    ...overrides,
  } as GameDefinition;
}

const BASE_OPTS = {
  awsRegion: 'ap-northeast-1',
  formatBlankVolume: false,
  fqdn: 'atm11.example.com',
  workerPublicUrl: 'https://discord-handler.example.workers.dev',
};

describe('buildUserData — sidecar block (Phase 3 Step 6)', () => {
  it('includes a docker run for the sidecar with GAME_ID / WORKER_URL / AWS_REGION env', () => {
    const ud = buildUserData({ game: makeGame(), ...BASE_OPTS });

    expect(ud).toContain('docker run -d');
    expect(ud).toContain('--name sidecar');
    // sidecar は game container の network namespace を共有して localhost:25575 RCON にアクセスする
    expect(ud).toContain('--network container:atm11');
    expect(ud).not.toContain('--network host');
    expect(ud).toContain('--restart unless-stopped');
    expect(ud).toContain("-e GAME_ID='atm11'");
    expect(ud).toContain("-e WORKER_URL='https://discord-handler.example.workers.dev'");
    expect(ud).toContain("-e AWS_REGION='ap-northeast-1'");
    expect(ud).toContain('gs-sidecar:latest');
  });

  it('strips trailing slashes from workerPublicUrl', () => {
    const ud = buildUserData({
      game: makeGame(),
      ...BASE_OPTS,
      workerPublicUrl: 'https://discord-handler.example.workers.dev///',
    });
    expect(ud).toContain("-e WORKER_URL='https://discord-handler.example.workers.dev'");
    expect(ud).not.toContain("-e WORKER_URL='https://discord-handler.example.workers.dev/'");
  });

  it('uses an explicit sidecarImage override when provided', () => {
    const ud = buildUserData({
      game: makeGame(),
      ...BASE_OPTS,
      sidecarImage: 'gs-sidecar:v2',
    });
    expect(ud).toContain('gs-sidecar:v2');
    // 標準 tag を **container 起動行に** 持ち越していないことの確認 (image 行の置換は確実に効く)。
    expect(ud).not.toMatch(/gs-sidecar:latest \|\| echo/);
  });

  it('loads the AMI-baked tar image before docker run', () => {
    const ud = buildUserData({ game: makeGame(), ...BASE_OPTS });
    expect(ud).toContain('docker load -i /var/lib/sidecar-image.tar');
  });

  it('places the sidecar block after the game docker run', () => {
    const ud = buildUserData({ game: makeGame(), ...BASE_OPTS });
    const gameIdx = ud.indexOf('--name atm11');
    const sidecarIdx = ud.indexOf('--name sidecar');
    expect(gameIdx).toBeGreaterThan(-1);
    expect(sidecarIdx).toBeGreaterThan(gameIdx);
  });
});

describe('buildUserData — image_source branching', () => {
  it('runs aws s3 cp + docker build when image_source = "build"', () => {
    const ud = buildUserData({
      game: makeGame({ image_source: 'build' }),
      ...BASE_OPTS,
    });
    expect(ud).toContain('aws s3 cp s3://gs-game-configs/launcher/atm11.tar.gz');
    expect(ud).toContain('docker build -t atm11-server:dev');
  });

  it('runs docker pull when image_source = "pull"', () => {
    const ud = buildUserData({
      game: makeGame({
        image_source: 'pull',
        container_image: 'itzg/minecraft-server:java21',
      }),
      ...BASE_OPTS,
    });
    expect(ud).toContain('docker pull itzg/minecraft-server:java21');
    expect(ud).not.toContain('aws s3 cp s3://gs-game-configs/launcher/atm11.tar.gz');
    expect(ud).not.toContain('docker build');
  });
});

describe('buildUserData — formatBlankVolume', () => {
  it('emits mkfs.ext4 + chown branch when formatBlankVolume=true', () => {
    const ud = buildUserData({
      game: makeGame(),
      ...BASE_OPTS,
      formatBlankVolume: true,
    });
    expect(ud).toContain('mkfs.ext4 -F /dev/nvme1n1');
    expect(ud).toContain('chown 1000:1000 /opt/atm11');
  });

  it('exits when no filesystem and formatBlankVolume=false', () => {
    const ud = buildUserData({
      game: makeGame(),
      ...BASE_OPTS,
      formatBlankVolume: false,
    });
    expect(ud).not.toContain('mkfs.ext4');
    expect(ud).toContain('no mountable filesystem');
  });
});

describe('buildUserData — seed_modpack_s3_uri', () => {
  it('downloads + unzips seed modpack only when formatBlankVolume=true AND uri set', () => {
    const ud = buildUserData({
      game: makeGame({
        seed_modpack_s3_uri: 's3://gs-game-configs/atm11/modpack/server-pack.zip',
      }),
      ...BASE_OPTS,
      formatBlankVolume: true,
    });
    expect(ud).toContain(
      "aws s3 cp 's3://gs-game-configs/atm11/modpack/server-pack.zip' /tmp/modpack.zip",
    );
    expect(ud).toContain('unzip -q -o /tmp/modpack.zip -d /opt/atm11');
    // 展開後に container uid に再 chown する (root 所有のまま container を起動すると writeback できない)
    expect(ud).toContain('chown -R 1000:1000 /opt/atm11');
    // dnf install に unzip が含まれていること (AL2023 base に無い)
    expect(ud).toContain('dnf install -y docker unzip');
  });

  it('skips seed modpack when formatBlankVolume=false (snapshot restore path)', () => {
    const ud = buildUserData({
      game: makeGame({
        seed_modpack_s3_uri: 's3://gs-game-configs/atm11/modpack/server-pack.zip',
      }),
      ...BASE_OPTS,
      formatBlankVolume: false,
    });
    // launcher tarball の `aws s3 cp` (build mode の既存処理) と区別するため、
    // modpack 専用 URI / 出力先で assert する。
    expect(ud).not.toContain('modpack/server-pack.zip');
    expect(ud).not.toContain('/tmp/modpack.zip');
    expect(ud).toContain('no seed modpack to apply');
  });

  it('skips seed modpack when uri is not set', () => {
    const ud = buildUserData({
      game: makeGame({ seed_modpack_s3_uri: undefined }),
      ...BASE_OPTS,
      formatBlankVolume: true,
    });
    expect(ud).not.toContain('/tmp/modpack.zip');
    expect(ud).toContain('no seed modpack to apply');
  });

  it('skips seed modpack when uri is empty string (disabled)', () => {
    const ud = buildUserData({
      game: makeGame({ seed_modpack_s3_uri: '' }),
      ...BASE_OPTS,
      formatBlankVolume: true,
    });
    expect(ud).not.toContain('/tmp/modpack.zip');
    expect(ud).toContain('no seed modpack to apply');
  });
});

describe('buildUserData — RCON / SNS optional sections', () => {
  it('fetches RCON password from SSM when registry has RCON_PASSWORD_FROM_SSM', () => {
    const ud = buildUserData({ game: makeGame(), ...BASE_OPTS });
    expect(ud).toContain('aws ssm get-parameter');
    expect(ud).toContain('--name /gs/atm11/rcon_password');
    expect(ud).toContain('-e RCON_PASSWORD="$RCON_PASSWORD"');
  });

  it('fetches multiple *_FROM_SSM values when registry declares several', () => {
    // 例: RCON_PASSWORD と CF_API_KEY (modpack 自動取得用) を同時に SSM 経由で取得するケース。
    const ud = buildUserData({
      game: makeGame({
        env: {
          EULA: 'TRUE',
          RCON_PASSWORD_FROM_SSM: '/gs/atm11/rcon_password',
          CF_API_KEY_FROM_SSM: '/gs/global/cf_api_key',
        },
      }),
      ...BASE_OPTS,
    });
    expect(ud).toContain('--name /gs/atm11/rcon_password');
    expect(ud).toContain('--name /gs/global/cf_api_key');
    expect(ud).toContain('-e RCON_PASSWORD="$RCON_PASSWORD"');
    expect(ud).toContain('-e CF_API_KEY="$CF_API_KEY"');
    // SSM 参照 hint そのものは container に渡らない (実値だけが -e で渡る)
    expect(ud).not.toContain('RCON_PASSWORD_FROM_SSM=');
    expect(ud).not.toContain('CF_API_KEY_FROM_SSM=');
  });

  it('skips SSM fetch when registry has no *_FROM_SSM keys', () => {
    const ud = buildUserData({
      game: makeGame({
        env: { EULA: 'TRUE' },
      }),
      ...BASE_OPTS,
    });
    expect(ud).not.toContain('aws ssm get-parameter');
    expect(ud).toContain('no *_FROM_SSM in registry');
  });

  it('treats *_FROM_SSM with empty value as disabled (no SSM fetch, no -e injection)', () => {
    const ud = buildUserData({
      game: makeGame({
        env: {
          EULA: 'TRUE',
          RCON_PASSWORD_FROM_SSM: '', // disabled
        },
      }),
      ...BASE_OPTS,
    });
    expect(ud).not.toContain('aws ssm get-parameter');
    expect(ud).not.toContain('-e RCON_PASSWORD=');
  });

  it('throws on unsafe SSM-derived env key', () => {
    // 不正な文字 (英数 + _ 以外) を含む key は bash 変数名として使えない → 早期 throw。
    expect(() =>
      buildUserData({
        game: makeGame({
          env: { 'BAD-KEY_FROM_SSM': '/some/path' },
        }),
        ...BASE_OPTS,
      }),
    ).toThrow(/unsafe SSM-derived env key/);
  });

  it('emits SNS publish only when readyNotifySnsTopicArn is provided', () => {
    const withSns = buildUserData({
      game: makeGame(),
      ...BASE_OPTS,
      readyNotifySnsTopicArn: 'arn:aws:sns:ap-northeast-1:1:gs-alerts',
    });
    expect(withSns).toContain('aws sns publish');
    expect(withSns).toContain('arn:aws:sns:ap-northeast-1:1:gs-alerts');

    const noSns = buildUserData({ game: makeGame(), ...BASE_OPTS });
    expect(noSns).not.toContain('aws sns publish');
  });
});
