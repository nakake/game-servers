// /stop — 起動中の game サーバーを graceful 停止して EC2 terminate、DNS を空にする。
//
// ADR 0002 に基づき: SSM Run Command で `docker stop --time=60` → container 内 trap が
// rcon save-all + stop → java exit → docker Stopped → EC2 terminate。
//
// terminate 後は data volume (/dev/sdf) の snapshot を取る。その volume の削除は Cron に
// 委譲する: snapshot 完成は数分かかり 1 invocation では待ち切れないため、ここでは KV に
// 削除予約を書くだけにし、Cron (handlers/cleanup.ts) が snapshot completed を確認して消す。
// available volume を残すと課金が続くので、停止のたびに (Cron 経由で) 掃除する。

import {
  AwsApiClient,
  createSnapshot,
  describeInstancesByTag,
  describeVolumesByTag,
  sendShellCommand,
  terminateInstances,
  waitForCommand,
  GAME_WORLD_SNAPSHOT_TAG_KEY,
  GAME_WORLD_SNAPSHOT_TAG_VALUE,
} from '../../lib/aws/index.js';
import { storePendingCleanup } from '../../lib/state/pending-cleanup.js';
import { CloudflareDnsClient } from '../../lib/cloudflare/index.js';
import { DiscordFollowUpClient } from '../../lib/discord/follow-up.js';
import {
  InteractionResponseType,
  type Interaction,
} from '../../lib/discord/types.js';
import { getGameById } from '../../lib/registry/atm11.js';
import type { Env } from '../../env.js';

const STOP_PLACEHOLDER_IP = '0.0.0.0';

export function handleStopCommand(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Response {
  // Phase 1 hardcode: 引数省略時は ATM11 を仮定 (現状 1 ゲームしか登録されていない)。
  const gameId = extractGameOption(interaction) ?? 'atm11';
  const game = getGameById(gameId);
  if (game === undefined) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `❌ Unknown game: \`${gameId}\`` },
    });
  }

  ctx.waitUntil(executeStop(game.game_id, interaction, env));

  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `⏳ ${gameId} を停止中…` },
  });
}

function extractGameOption(interaction: Interaction): string | undefined {
  const option = interaction.data?.options?.find((o) => o.name === 'game');
  return typeof option?.value === 'string' ? option.value : undefined;
}

async function executeStop(gameId: string, interaction: Interaction, env: Env): Promise<void> {
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
    // 1. Tag で running な instance を取得
    const running = await describeInstancesByTag(ec2, { Game: gameId });
    const inst = running[0];
    if (inst === undefined) {
      await safeEdit(followUp, `ℹ️ \`${gameId}\` は既に停止しています`);
      return;
    }

    // 2. attached な game-world volume を特定 (CreateSnapshot 対象)。
    //    Tag フィルタだと RunInstances の TagSpecification(ResourceType=volume) が
    //    root volume も同じ Tag で巻き込んでしまうため、device 名 (/dev/sdf) で
    //    deterministic に絞り込む。/start が blockDeviceMappings で指定する device。
    const dataDevice = '/dev/sdf';
    const volumes = await describeVolumesByTag(
      ec2,
      { Game: gameId, Purpose: 'game-world' },
      ['in-use'],
    );
    const liveVolume = volumes.find((v) =>
      v.attachments.some(
        (a) => a.instanceId === inst.instanceId && a.device === dataDevice,
      ),
    );
    if (liveVolume === undefined) {
      await safeEdit(
        followUp,
        `⚠️ game-world volume が見つかりません (instance=${inst.instanceId}, device=${dataDevice})。\n` +
          `snapshot をスキップして停止続行します`,
      );
    }

    // 3. SSM で docker stop (graceful, container 内 trap が rcon save-all + stop)
    const containerName = gameId;
    const graceSeconds = 60;
    const sent = await sendShellCommand(ec2, {
      instanceIds: [inst.instanceId],
      commands: [`docker stop --time=${graceSeconds} ${containerName}`],
      timeoutSeconds: graceSeconds + 30,
      comment: `/stop ${gameId}`,
    });
    await safeEdit(followUp, `⏳ docker stop 発火: \`${sent.commandId}\` 完了待ち…`);

    const invocation = await waitForCommand(ec2, {
      commandId: sent.commandId,
      instanceId: inst.instanceId,
      timeoutMs: (graceSeconds + 60) * 1000,
      pollIntervalMs: 2000,
    });

    if (invocation.status !== 'Success') {
      await safeEdit(
        followUp,
        `❌ docker stop failed: status=${invocation.status}\n` +
          `stderr: ${invocation.standardErrorContent.slice(0, 300)}`,
      );
      // それでも snapshot + terminate には進む (container が無いケースもあり得るため)
    }

    // 4. CreateSnapshot (fire-and-forget、AWS 側で async 完了)
    let snapshotIdForNotice: string | undefined;
    if (liveVolume !== undefined) {
      try {
        const snap = await createSnapshot(ec2, {
          volumeId: liveVolume.volumeId,
          description: `gs-${gameId} stop snapshot ${new Date().toISOString()}`,
          tags: {
            Project: 'game-servers',
            Game: gameId,
            Purpose: 'game-world',
            // getLatestCompletedSnapshot が root クローンと区別するためのマーカー。
            // ここは /dev/sdf の data volume (liveVolume) だけを snapshot しているので
            // このマーカーを付けてよい (root volume には付かない)。
            [GAME_WORLD_SNAPSHOT_TAG_KEY]: GAME_WORLD_SNAPSHOT_TAG_VALUE,
            CreatedAt: new Date().toISOString(),
          },
        });
        snapshotIdForNotice = snap.snapshotId;
        await safeEdit(
          followUp,
          `⏳ snapshot \`${snap.snapshotId}\` 作成中 (AWS 側で async 完了)、terminate に進みます…`,
        );
      } catch (err) {
        console.error('CreateSnapshot failed:', err);
        await safeEdit(
          followUp,
          `⚠️ snapshot 作成失敗: ${err instanceof Error ? err.message : String(err)}\n` +
            `terminate を続行します (旧 volume は Available 状態で残ります)`,
        );
      }
    }

    // 5. EC2 terminate (EBS volume は deleteOnTermination=false で残る)
    await terminateInstances(ec2, [inst.instanceId]);

    // 6. DNS を placeholder に上書き
    try {
      const fqdn = `${game.subdomain}.${env.CLOUDFLARE_BASE_DOMAIN}`;
      await cf.updateRecord({
        zoneId: env.CLOUDFLARE_ZONE_ID,
        recordId: env.ATM11_CF_RECORD_ID,
        type: 'A',
        name: fqdn,
        content: STOP_PLACEHOLDER_IP,
        ttl: 60,
        proxied: false,
        comment: `gs-${gameId} stopped at ${new Date().toISOString()}`,
      });
    } catch (err) {
      console.error('DNS clear failed:', err);
    }

    // 7. 旧 data volume の削除は Cron に委譲する。
    //    snapshot 完成は数分かかり、Worker の 1 invocation では待ち切れない (実行時間制限で
    //    途中 kill される)。ここでは「snapshot 完成後に消す volume」を KV に記録するだけにし、
    //    Cron Trigger (handlers/cleanup.ts) が completed を確認して削除する。
    let volumeNote = '';
    if (snapshotIdForNotice !== undefined && liveVolume !== undefined) {
      if (env.SERVER_STATE !== undefined) {
        try {
          await storePendingCleanup(env.SERVER_STATE, {
            gameId,
            volumeId: liveVolume.volumeId,
            snapshotId: snapshotIdForNotice,
            requestedAt: new Date().toISOString(),
          });
          volumeNote = `\n旧 volume \`${liveVolume.volumeId}\` は snapshot 完成後に自動削除されます`;
        } catch (err) {
          console.error('storePendingCleanup failed:', err);
          volumeNote =
            `\n⚠️ 旧 volume \`${liveVolume.volumeId}\` の自動削除予約に失敗しました (手動削除が必要)`;
        }
      } else {
        volumeNote =
          `\n⚠️ 旧 volume \`${liveVolume.volumeId}\` は手動削除が必要です ` +
          `(SERVER_STATE KV 未設定で Cron が拾えない)`;
      }
    }

    const snapshotNote = snapshotIdForNotice !== undefined
      ? `\nsnapshot: \`${snapshotIdForNotice}\` (次回 /start で使用)`
      : '';
    await safeEdit(followUp, `✅ ${game.discord.stop_message}${snapshotNote}${volumeNote}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeEdit(followUp, `❌ \`/stop ${gameId}\` failed: ${msg.slice(0, 500)}`);
  }
}

async function safeEdit(client: DiscordFollowUpClient, content: string): Promise<void> {
  try {
    await client.editOriginal(content);
  } catch (err) {
    console.error('Discord followUp editOriginal failed:', err);
  }
}
