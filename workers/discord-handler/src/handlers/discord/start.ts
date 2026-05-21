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
  getLatestSnapshot,
  runInstances,
  waitForInstanceRunning,
  waitForSnapshotCompleted,
} from '../../lib/aws/index.js';
import { CloudflareDnsClient } from '../../lib/cloudflare/index.js';
import { DiscordFollowUpClient } from '../../lib/discord/follow-up.js';
import {
  InteractionResponseType,
  type Interaction,
} from '../../lib/discord/types.js';
import { base64EncodeUserData, buildAtm11UserData } from '../../lib/launcher/user-data.js';
import { getGameById } from '../../lib/registry/atm11.js';
import { storePendingReady } from '../../lib/state/pending-ready.js';
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

    // 2. 復元元 snapshot を決める。最新の game-world snapshot を state 問わず取得し:
    //      completed → そのまま使用
    //      pending   → completed まで待機 (/stop と /start が重なった時の保険。通常は
    //                  /stop 側が完成を見届けてから終わるのでここは通らない)
    //      その他    → 最新の completed snapshot にフォールバック
    //    snapshot が 1 つも無ければ env seed (= 初回起動時の Phase 0 snapshot)。
    const snapshotTags = { Game: gameId, Purpose: 'game-world' };
    const latest = await getLatestSnapshot(ec2, snapshotTags);
    let snapshotId: string;
    let snapshotNote: string;
    if (latest === undefined) {
      snapshotId = env.ATM11_SNAPSHOT_ID;
      snapshotNote = `env seed \`${snapshotId}\` (初回起動)`;
    } else if (latest.state === 'completed') {
      snapshotId = latest.snapshotId;
      snapshotNote = `latest \`${snapshotId}\` (${latest.startTime})`;
    } else if (latest.state === 'pending') {
      // 直近の /stop snapshot がまだ完成していない。一つ前に巻き戻さず完成を待つが、
      // Worker の実行時間制限があるので最大 120s で打ち切り、超えたら最新 completed に
      // フォールバックする (通常は /stop からしばらく経ってから /start するので待ちは発生しない)。
      await safeEdit(
        followUp,
        `⏳ 直近の停止 snapshot \`${latest.snapshotId}\` を完成待ち中… (${latest.progress})`,
      );
      try {
        await waitForSnapshotCompleted(ec2, {
          snapshotId: latest.snapshotId,
          timeoutMs: 120_000,
          pollIntervalMs: 5000,
        });
        snapshotId = latest.snapshotId;
        snapshotNote = `latest \`${snapshotId}\` (完成待ち後)`;
      } catch (err) {
        console.error('waitForSnapshotCompleted failed, falling back:', err);
        const completed = await getLatestCompletedSnapshot(ec2, snapshotTags);
        snapshotId = completed?.snapshotId ?? env.ATM11_SNAPSHOT_ID;
        snapshotNote = completed !== undefined
          ? `fallback latest completed \`${snapshotId}\``
          : `env seed \`${snapshotId}\``;
      }
    } else {
      // error / recoverable / recovering — 最新の completed にフォールバック。
      const completed = await getLatestCompletedSnapshot(ec2, snapshotTags);
      snapshotId = completed?.snapshotId ?? env.ATM11_SNAPSHOT_ID;
      snapshotNote = completed !== undefined
        ? `latest completed \`${snapshotId}\` (最新 snapshot は ${latest.state})`
        : `env seed \`${snapshotId}\``;
    }
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

    // この時点で完了しているのは「EC2 が running になり DNS が向いた」ところまで。
    // コンテナ起動 + MC のワールド読み込みはこの後 EC2 内で進む。よって「起動完了」では
    // なく「準備中」を表示し、本当に接続可能になったら ready 通知 (SNS) でこのメッセージを
    // ✅ に更新する。
    const port = game.ports[0]?.port ?? 25565;
    await safeEdit(
      followUp,
      `🟡 ${game.display_name} 起動準備中…\n` +
        `\`${fqdn}:${port}\` (IP: \`${inst.publicIp}\`, instanceId: \`${instanceId}\`)\n` +
        `※ EC2 は稼働を開始しました。コンテナ起動と MC のワールド読み込みに数分かかります。\n` +
        `　接続できるようになったら、このメッセージを更新して @ でお知らせします。`,
    );

    // ready 通知 (SNS 経由) が後からこの元メッセージを ✅ に編集し、起動した人を mention
    // できるよう、interaction の文脈を KV に保存する。
    // SERVER_STATE が未バインドなら skip → ready 通知は webhook のみ (編集 / mention なし)。
    if (env.SERVER_STATE !== undefined) {
      const userId = interaction.member?.user?.id ?? interaction.user?.id;
      await storePendingReady(env.SERVER_STATE, {
        applicationId: env.DISCORD_APPLICATION_ID,
        interactionToken: interaction.token,
        gameId,
        fqdn,
        port,
        startedAt: new Date().toISOString(),
        ...(userId !== undefined ? { userId } : {}),
        ...(interaction.channel_id !== undefined ? { channelId: interaction.channel_id } : {}),
      }).catch((err) => console.error('storePendingReady failed:', err));
    }
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
