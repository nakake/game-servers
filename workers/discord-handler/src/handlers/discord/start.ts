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
import { base64EncodeUserData, buildUserData } from '../../lib/launcher/user-data.js';
import { getGame } from '../../lib/registry/store.js';
import type { GameDefinition } from '../../lib/registry/types.js';
import { storePendingReady } from '../../lib/state/pending-ready.js';
import type { Env } from '../../env.js';

export async function handleStartCommand(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const gameId = extractGameOption(interaction);
  const game = gameId !== undefined ? await getGame(env.GAME_REGISTRY, gameId) : undefined;
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
  ctx.waitUntil(executeStart(game, interaction, env));

  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `⏳ ${game.discord.start_message}` },
  });
}

function extractGameOption(interaction: Interaction): string | undefined {
  const option = interaction.data?.options?.find((o) => o.name === 'game');
  return typeof option?.value === 'string' ? option.value : undefined;
}

async function executeStart(
  game: GameDefinition,
  interaction: Interaction,
  env: Env,
): Promise<void> {
  const followUp = new DiscordFollowUpClient({
    applicationId: env.DISCORD_APPLICATION_ID,
    interactionToken: interaction.token,
  });

  const gameId = game.game_id;

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
    const seedSnapshotId = game.seed_snapshot_id ?? undefined;
    const latest = await getLatestSnapshot(ec2, snapshotTags);
    let snapshotId: string | undefined;
    let snapshotNote: string;
    if (latest === undefined) {
      snapshotId = seedSnapshotId;
      snapshotNote = describeSeed(seedSnapshotId);
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
        snapshotId = completed?.snapshotId ?? seedSnapshotId;
        snapshotNote = completed !== undefined
          ? `fallback latest completed \`${completed.snapshotId}\``
          : describeSeed(seedSnapshotId);
      }
    } else {
      // error / recoverable / recovering — 最新の completed にフォールバック。
      const completed = await getLatestCompletedSnapshot(ec2, snapshotTags);
      snapshotId = completed?.snapshotId ?? seedSnapshotId;
      snapshotNote = completed !== undefined
        ? `latest completed \`${completed.snapshotId}\` (最新 snapshot は ${latest.state})`
        : describeSeed(seedSnapshotId);
    }
    await safeEdit(followUp, `⏳ snapshot 確定: ${snapshotNote}、EC2 起動中…`);

    // user-data 生成 (EBS mount → image 準備 → SSM から RCON pw → docker run)。
    // ゲーム差 (build/pull、blank EBS の要否) は buildUserData が registry から判断する。
    const awsRegion = env.AWS_REGION ?? 'ap-northeast-1';
    const fqdn = `${game.subdomain}.${env.CLOUDFLARE_BASE_DOMAIN}`;
    const userData = base64EncodeUserData(
      buildUserData({
        game,
        awsRegion,
        formatBlankVolume: snapshotId === undefined,
        fqdn,
        ...(env.SNS_ALLOWED_TOPIC_ARN !== undefined && env.SNS_ALLOWED_TOPIC_ARN !== ''
          ? { readyNotifySnsTopicArn: env.SNS_ALLOWED_TOPIC_ARN }
          : {}),
      }),
    );

    // 4. RunInstances — Launch Template (gs-game-server) 経由で起動 (IaC 移行 Step 5)。
    //    AMI / Key / SG / IAM profile / Spot 設定 / EBS base / 静的タグは LT 側で定義済み。
    //    ここではゲーム別の値だけ override する:
    //      - instanceType : registry の instance_types[0]
    //      - subnetId     : LT には含めない (default VPC の subnet を Worker が指定)
    //      - userData     : LT は空、Worker が生成して渡す
    //      - blockDeviceMappings : /dev/sdf を全フィールド指定で渡す。snapshotId / volumeSize
    //        はゲーム別。volumeType / deleteOnTermination も明示する — LT に同名 device が
    //        あっても request 側の device 指定が優先されるため、deleteOnTermination=false
    //        (world データ保護) を LT 任せにせず必ずここで指定する。
    //      - instanceTags / volumeTags : LT の静的タグとマージされるが、Project は Worker 側でも
    //        必ず付ける — gs-worker-caller の ssm:SendCommand が aws:ResourceTag/Project に
    //        条件付けされており /stop が依存するため、マージ挙動に賭けない。
    const primaryInstanceType = game.instance_types[0] ?? 'r7a.large';
    const result = await runInstances(ec2, {
      launchTemplate: { launchTemplateId: env.EC2_LAUNCH_TEMPLATE_ID, version: '$Latest' },
      instanceType: primaryInstanceType,
      subnetId: env.EC2_SUBNET_ID,
      userData,
      instanceTags: {
        Project: 'game-servers',
        Game: gameId,
        Env: 'prod',
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
            // snapshotId 未指定 = blank volume (user-data が mkfs.ext4 する)
            ...(snapshotId !== undefined ? { snapshotId } : {}),
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
      recordId: game.cf_record_id,
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

// snapshot が 1 つも無いときの note 文言 (registry の seed を使うか blank EBS か)。
function describeSeed(seedSnapshotId: string | undefined): string {
  return seedSnapshotId !== undefined
    ? `registry seed \`${seedSnapshotId}\` (初回起動)`
    : 'blank EBS (初回起動、空ボリュームを mkfs)';
}

// follow-up が失敗しても処理を継続するためのラッパ。
async function safeEdit(client: DiscordFollowUpClient, content: string): Promise<void> {
  try {
    await client.editOriginal(content);
  } catch (err) {
    console.error('Discord followUp editOriginal failed:', err);
  }
}
