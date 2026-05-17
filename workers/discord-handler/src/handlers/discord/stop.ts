// /stop — 起動中の game サーバーを graceful 停止して EC2 terminate、DNS を空にする。
//
// ADR 0002 に基づき: SSM Run Command で `docker stop --time=60` → container 内 trap が
// rcon save-all + stop → java exit → docker Stopped → EC2 terminate。
//
// Phase 1 hardcode: EBS snapshot 作成は EBS lib 未実装のため skip。`/start` 時に
// snapshotId から復元する経路だけ動かす (上書き snapshot は手動 or 次フェーズ)。

import {
  AwsApiClient,
  createSnapshot,
  describeInstancesByTag,
  describeVolumesByTag,
  sendShellCommand,
  terminateInstances,
  waitForCommand,
} from '../../lib/aws/index.js';
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

    // 2. attached な game-world volume を特定 (CreateSnapshot 対象)
    const volumes = await describeVolumesByTag(
      ec2,
      { Game: gameId, Purpose: 'game-world' },
      ['in-use'],
    );
    const liveVolume = volumes.find((v) =>
      v.attachments.some((a) => a.instanceId === inst.instanceId),
    );
    if (liveVolume === undefined) {
      await safeEdit(
        followUp,
        `⚠️ game-world volume が見つかりません (Tag Game=${gameId},Purpose=game-world)。\n` +
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

    const snapshotNote = snapshotIdForNotice !== undefined
      ? `\nsnapshot: \`${snapshotIdForNotice}\` (進行中、次回 /start で使用)`
      : '';
    await safeEdit(followUp, `✅ ${game.discord.stop_message}${snapshotNote}`);
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
