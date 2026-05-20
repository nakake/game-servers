// /start <game> — Spot EC2 を起動し、DNS を更新し、Discord に完了通知。
//
// Discord 3 秒制約: deferred response (type 5) を即座に返し、重い処理は ctx.waitUntil 内で実行。
//
// Phase 1 hardcode: docker run の自動化は含まない (AMI に焼かれていないため)。
// 起動完了後ユーザーが SSH で `docker run` する経路を維持。完全自動化は Phase 4 で AMI 焼直し。

import {
  AwsApiClient,
  describeInstancesByTag,
  getLatestCompletedSnapshot,
  runInstances,
  waitForInstanceRunning,
} from '../../lib/aws/index.js';
import { CloudflareDnsClient } from '../../lib/cloudflare/index.js';
import { DiscordFollowUpClient } from '../../lib/discord/follow-up.js';
import {
  InteractionResponseType,
  type Interaction,
} from '../../lib/discord/types.js';
import { base64EncodeUserData, buildAtm11UserData } from '../../lib/launcher/user-data.js';
import { getGameById } from '../../lib/registry/atm11.js';
import type { Env } from '../../env.js';

export function handleStartCommand(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Response {
  const gameId = extractGameOption(interaction);
  const game = gameId !== undefined ? getGameById(gameId) : undefined;
  if (game === undefined) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `❌ Unknown game: \`${gameId ?? '(missing)'}\`` },
    });
  }
  if (!game.enabled) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `⚠️ ゲーム \`${gameId}\` は無効化されています` },
    });
  }

  // 重い処理は waitUntil で後追い。Discord には先に deferred response を返す。
  ctx.waitUntil(executeStart(game.game_id, interaction, env));

  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `⏳ ${game.discord.start_message}` },
  });
}

function extractGameOption(interaction: Interaction): string | undefined {
  const option = interaction.data?.options?.find((o) => o.name === 'game');
  return typeof option?.value === 'string' ? option.value : undefined;
}

async function executeStart(gameId: string, interaction: Interaction, env: Env): Promise<void> {
  const followUp = new DiscordFollowUpClient({
    applicationId: env.DISCORD_APPLICATION_ID,
    interactionToken: interaction.token,
  });

  const game = getGameById(gameId);
  if (game === undefined) {
    await safeEdit(followUp, `❌ registry lookup failed: ${gameId}`);
    return;
  }

  const ec2 = new AwsApiClient({
    region: env.AWS_REGION ?? 'ap-northeast-1',
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  const cf = new CloudflareDnsClient({ apiToken: env.CLOUDFLARE_DNS_API_TOKEN });

  try {
    // 1. 重複起動チェック (Game タグで running/pending を検索)
    const existing = await describeInstancesByTag(ec2, { Game: gameId });
    if (existing.length > 0 && existing[0] !== undefined) {
      const inst = existing[0];
      await safeEdit(
        followUp,
        `⚠️ \`${gameId}\` は既に ${inst.state} 状態です\n` +
          `instanceId: \`${inst.instanceId}\`` +
          (inst.publicIp !== undefined ? `\nIP: \`${inst.publicIp}\`` : ''),
      );
      return;
    }

    // 2. latest completed snapshot を取得 (なければ env seed = Phase 0 snapshot)
    const latest = await getLatestCompletedSnapshot(ec2, {
      Game: gameId,
      Purpose: 'game-world',
    });
    const snapshotId = latest?.snapshotId ?? env.ATM11_SNAPSHOT_ID;
    const snapshotNote = latest !== undefined
      ? `latest \`${snapshotId}\` (${latest.startTime})`
      : `env seed \`${snapshotId}\``;
    await safeEdit(followUp, `⏳ snapshot 確定: ${snapshotNote}、EC2 起動中…`);

    // 3. user-data 生成 (EBS mount → S3 から launcher tarball → SSM から RCON pw → docker build/run)
    const awsRegion = env.AWS_REGION ?? 'ap-northeast-1';
    const fqdn = `${game.subdomain}.${env.CLOUDFLARE_BASE_DOMAIN}`;
    const userData = base64EncodeUserData(
      buildAtm11UserData({
        game,
        launcherTarballS3Uri: env.LAUNCHER_TARBALL_S3_URI,
        rconPasswordSsmPath: env.ATM11_RCON_PASSWORD_SSM_PATH,
        awsRegion,
        fqdn,
        ...(env.SNS_ALLOWED_TOPIC_ARN !== undefined && env.SNS_ALLOWED_TOPIC_ARN !== ''
          ? { readyNotifySnsTopicArn: env.SNS_ALLOWED_TOPIC_ARN }
          : {}),
      }),
    );

    // 4. RunInstances (Spot, snapshot から root とは別 EBS を attach)
    const primaryInstanceType = game.instance_types[0] ?? 'r7a.large';
    const result = await runInstances(ec2, {
      imageId: env.EC2_IMAGE_ID,
      instanceType: primaryInstanceType,
      keyName: env.EC2_KEY_NAME,
      securityGroupIds: [env.EC2_SECURITY_GROUP_ID],
      subnetId: env.EC2_SUBNET_ID,
      iamInstanceProfileName: env.EC2_INSTANCE_PROFILE_NAME,
      userData,
      spot: true,
      instanceTags: {
        Project: 'game-servers',
        Game: gameId,
        Env: 'phase1',
        Name: `gs-${gameId}`,
      },
      volumeTags: {
        Project: 'game-servers',
        Game: gameId,
        Purpose: 'game-world',
      },
      blockDeviceMappings: [
        {
          deviceName: '/dev/sdf',
          ebs: {
            snapshotId,
            volumeSize: game.ebs_size_gb,
            volumeType: 'gp3',
            deleteOnTermination: false,
          },
        },
      ],
    });
    const instanceId = result.instances[0]?.instanceId;
    if (instanceId === undefined) {
      await safeEdit(followUp, `❌ RunInstances returned no instance`);
      return;
    }

    await safeEdit(followUp, `⏳ EC2 \`${instanceId}\` 起動中… (running + public IP 待ち)`);

    // 3. running + public IP 取得まで待機
    const inst = await waitForInstanceRunning(ec2, {
      instanceId,
      timeoutMs: 240_000,
      pollIntervalMs: 5000,
    });

    if (inst.publicIp === undefined) {
      await safeEdit(followUp, `❌ instance is running but no public IP assigned`);
      return;
    }

    // 4. Cloudflare DNS 更新
    await cf.updateRecord({
      zoneId: env.CLOUDFLARE_ZONE_ID,
      recordId: env.ATM11_CF_RECORD_ID,
      type: 'A',
      name: fqdn,
      content: inst.publicIp,
      ttl: 60,
      proxied: false,
      comment: `gs-${gameId} ${new Date().toISOString()}`,
    });

    const port = game.ports[0]?.port ?? 25565;
    await safeEdit(
      followUp,
      `✅ ${game.discord.ready_message}\n` +
        `\`${fqdn}:${port}\` (IP: \`${inst.publicIp}\`, instanceId: \`${instanceId}\`)\n` +
        `※ container の起動に追加 1-2 分かかります (image build)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeEdit(followUp, `❌ \`/start ${gameId}\` failed: ${msg.slice(0, 500)}`);
  }
}

// follow-up が失敗しても処理を継続するためのラッパ。
async function safeEdit(client: DiscordFollowUpClient, content: string): Promise<void> {
  try {
    await client.editOriginal(content);
  } catch (err) {
    console.error('Discord followUp editOriginal failed:', err);
  }
}
