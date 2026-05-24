// runStopWorkflow — game サーバーを stop する共通フロー。
//
// Phase 3 で 3 つの経路から呼ばれる:
//   - Discord `/stop` ハンドラ (handlers/discord/stop.ts)
//   - sidecar `/sidecar/idle-detected` ハンドラ (Step 2)
//   - Cron フォールバック (Step 3、sidecar 沈黙時の保険)
//
// 流れは Phase 1 で `/stop` が確立した順序を踏襲する:
//   0. SERVER_STATE に `stop-in-progress:<game>` ロック (decision 11)
//   1. running instance 取得
//   2. expectedInstanceId 照合 (sidecar / cron 用)
//   3. /dev/sdf attached の game-world volume 特定
//   4. SSM docker stop (graceful、container 内 trap が rcon save-all + stop)
//   5. CreateSnapshot (AWS 側で async 完了、ここでは fire-and-forget)
//   6. EC2 terminate
//   7. DNS A レコードを placeholder に
//   8. pending cleanup を SERVER_STATE に予約 (Cron が snapshot 完成後に volume 削除)
//
// 戻り値は discriminated union で、呼び出し側が状況別にメッセージを整形できる。
// snapshot や DNS の失敗は workflow を止めず、note として持ち上げる (Phase 1 の挙動を保持)。

import {
  AwsApiClient,
  createSnapshot,
  describeInstancesByTag,
  describeVolumesByTag,
  getAwsCredentials,
  sendShellCommand,
  terminateInstances,
  waitForCommand,
  GAME_WORLD_SNAPSHOT_TAG_KEY,
  GAME_WORLD_SNAPSHOT_TAG_VALUE,
} from '../lib/aws/index.js';
import { CloudflareDnsClient } from '../lib/cloudflare/index.js';
import { buildIdleStopNotification } from '../lib/discord/notifications.js';
import { postDiscordWebhookMessage } from '../lib/discord/webhook.js';
import { storePendingCleanup } from '../lib/state/pending-cleanup.js';
import type { GameDefinition } from '../lib/registry/types.js';
import type { Env } from '../env.js';

const STOP_PLACEHOLDER_IP = '0.0.0.0';
const STOP_LOCK_KEY_PREFIX = 'stop-in-progress:';
const STOP_LOCK_TTL_SECONDS = 600;
const DATA_DEVICE = '/dev/sdf';
const DOCKER_STOP_GRACE_SECONDS = 60;

export type StopTrigger = 'discord' | 'sidecar' | 'cron-fallback';

export interface RunStopWorkflowOptions {
  triggeredBy: StopTrigger;
  // 進捗を呼び出し側に出すコールバック。Discord ハンドラは follow-up edit に使う。
  // sidecar / cron-fallback は通常省略 (workflow 内で console.log は常時出力する)。
  // コールバックの失敗は workflow を止めない (内部で catch する)。
  onProgress?: (message: string) => Promise<void> | void;
  // sidecar / cron-fallback が「自分が観測している instance」を指定する。
  // 現在 running の instance と一致しなければ instance-mismatch を返して中断
  // (古い instance への晩到 stop が新 instance を巻き込むのを防ぐ)。
  expectedInstanceId?: string;
}

export type StopWorkflowOutcome =
  | {
      status: 'ok';
      instanceId: string;
      snapshotId?: string;
      volumeId?: string;
      // snapshot 作成例外時のみ true (workflow は続行する)。
      snapshotFailed?: boolean;
      // 旧 volume の Cron 経由削除を予約できたか (snapshot が無いと予約しない)。
      pendingCleanupScheduled: boolean;
      // DNS A レコードを placeholder に戻せたか。
      dnsReset: boolean;
      // docker stop SSM コマンドが Success を返したか (false でも snapshot + terminate には進む)。
      dockerStopSucceeded: boolean;
    }
  | {
      status: 'already-stopped';
      reason: 'no-instance' | 'in-progress' | 'instance-mismatch';
      // instance-mismatch のとき、現在 running の instance ID。
      currentInstanceId?: string;
    }
  | {
      status: 'failed';
      error: string;
      instanceId?: string;
    };

export async function runStopWorkflow(
  env: Env,
  ctx: ExecutionContext,
  game: GameDefinition,
  opts: RunStopWorkflowOptions,
): Promise<StopWorkflowOutcome> {
  const outcome = await executeStopWorkflow(env, ctx, game, opts);

  // Phase 4 Step 2: Discord 経由以外の発火 (sidecar / cron-fallback) は Discord channel に
  // webhook 通知を出す。Discord 経由は元 interaction の follow-up edit が既に出るので不要。
  // 通知失敗は本フローを止めない (postDiscordWebhookMessage 自体も throw しない契約)。
  if (opts.triggeredBy !== 'discord') {
    const embed = buildIdleStopNotification(game, outcome, opts.triggeredBy);
    if (embed !== undefined) {
      try {
        await postDiscordWebhookMessage(env, { embeds: [embed] });
      } catch (err) {
        console.error('idle-stop notification post threw:', err);
      }
    }
  }

  return outcome;
}

async function executeStopWorkflow(
  env: Env,
  ctx: ExecutionContext,
  game: GameDefinition,
  opts: RunStopWorkflowOptions,
): Promise<StopWorkflowOutcome> {
  const gameId = game.game_id;
  const lockKey = `${STOP_LOCK_KEY_PREFIX}${gameId}`;
  const progress = wrapProgress(opts.onProgress);

  // 0. 重複発火防止のロック (decision 11)。KV は eventual consistency なので厳密な排他は
  // 期待できないが、現実的な発火間隔 (sidecar vs cron は 5 分窓) では十分機能する。
  const existingLock = await env.SERVER_STATE.get(lockKey);
  if (existingLock !== null) {
    return { status: 'already-stopped', reason: 'in-progress' };
  }
  await env.SERVER_STATE.put(
    lockKey,
    JSON.stringify({
      triggeredBy: opts.triggeredBy,
      startedAt: new Date().toISOString(),
    }),
    { expirationTtl: STOP_LOCK_TTL_SECONDS },
  );

  try {
    const credentials = await getAwsCredentials(env, ctx);
    const ec2 = new AwsApiClient({
      region: env.AWS_REGION ?? 'ap-northeast-1',
      credentials,
    });
    const cf = new CloudflareDnsClient({ apiToken: env.CLOUDFLARE_DNS_API_TOKEN });

    // 1. running instance
    const running = await describeInstancesByTag(ec2, { Game: gameId });
    const inst = running[0];
    if (inst === undefined) {
      return { status: 'already-stopped', reason: 'no-instance' };
    }

    // 2. expectedInstanceId 照合
    if (
      opts.expectedInstanceId !== undefined &&
      inst.instanceId !== opts.expectedInstanceId
    ) {
      return {
        status: 'already-stopped',
        reason: 'instance-mismatch',
        currentInstanceId: inst.instanceId,
      };
    }

    // 3. game-world volume (Tag フィルタは root volume も巻き込むため device 名で絞る)
    const volumes = await describeVolumesByTag(
      ec2,
      { Game: gameId, Purpose: 'game-world' },
      ['in-use'],
    );
    const liveVolume = volumes.find((v) =>
      v.attachments.some(
        (a) => a.instanceId === inst.instanceId && a.device === DATA_DEVICE,
      ),
    );
    if (liveVolume === undefined) {
      await progress(
        `⚠️ game-world volume が見つかりません (instance=${inst.instanceId}, device=${DATA_DEVICE})。` +
          ` snapshot をスキップして停止続行します`,
      );
    }

    // 4. SSM で docker stop (graceful、container 内 trap が rcon save-all + stop)
    const containerName = gameId;
    const sent = await sendShellCommand(ec2, {
      instanceIds: [inst.instanceId],
      commands: [`docker stop --time=${DOCKER_STOP_GRACE_SECONDS} ${containerName}`],
      timeoutSeconds: DOCKER_STOP_GRACE_SECONDS + 30,
      comment: `stop ${gameId} (${opts.triggeredBy})`,
    });
    await progress(`⏳ docker stop 発火: \`${sent.commandId}\` 完了待ち…`);

    const invocation = await waitForCommand(ec2, {
      commandId: sent.commandId,
      instanceId: inst.instanceId,
      timeoutMs: (DOCKER_STOP_GRACE_SECONDS + 60) * 1000,
      pollIntervalMs: 2000,
    });
    const dockerStopSucceeded = invocation.status === 'Success';
    if (!dockerStopSucceeded) {
      await progress(
        `❌ docker stop failed: status=${invocation.status}\n` +
          `stderr: ${invocation.standardErrorContent.slice(0, 300)}`,
      );
      // それでも snapshot + terminate には進む (container が無いケースもあり得るため)
    }

    // 5. CreateSnapshot (fire-and-forget、AWS 側で async 完了)
    let snapshotId: string | undefined;
    let snapshotFailed = false;
    if (liveVolume !== undefined) {
      try {
        const snap = await createSnapshot(ec2, {
          volumeId: liveVolume.volumeId,
          description: `gs-${gameId} stop snapshot ${new Date().toISOString()}`,
          tags: {
            Project: 'game-servers',
            Game: gameId,
            Env: 'prod',
            Purpose: 'game-world',
            [GAME_WORLD_SNAPSHOT_TAG_KEY]: GAME_WORLD_SNAPSHOT_TAG_VALUE,
            CreatedAt: new Date().toISOString(),
            StopTrigger: opts.triggeredBy,
          },
        });
        snapshotId = snap.snapshotId;
        await progress(
          `⏳ snapshot \`${snap.snapshotId}\` 作成中 (AWS 側で async 完了)、terminate に進みます…`,
        );
      } catch (err) {
        console.error('CreateSnapshot failed:', err);
        snapshotFailed = true;
        await progress(
          `⚠️ snapshot 作成失敗: ${err instanceof Error ? err.message : String(err)}\n` +
            `terminate を続行します (旧 volume は Available 状態で残ります)`,
        );
      }
    }

    // 6. EC2 terminate (data volume は deleteOnTermination=false で残る)
    await terminateInstances(ec2, [inst.instanceId]);

    // 7. DNS を placeholder に
    let dnsReset = false;
    try {
      const fqdn = `${game.subdomain}.${env.CLOUDFLARE_BASE_DOMAIN}`;
      await cf.updateRecord({
        zoneId: env.CLOUDFLARE_ZONE_ID,
        recordId: game.cf_record_id,
        type: 'A',
        name: fqdn,
        content: STOP_PLACEHOLDER_IP,
        ttl: 60,
        proxied: false,
        comment: `gs-${gameId} stopped at ${new Date().toISOString()} (${opts.triggeredBy})`,
      });
      dnsReset = true;
    } catch (err) {
      console.error('DNS clear failed:', err);
    }

    // 8. pending cleanup を SERVER_STATE に登録 (旧 volume を Cron が消す)
    let pendingCleanupScheduled = false;
    if (snapshotId !== undefined && liveVolume !== undefined) {
      try {
        await storePendingCleanup(env.SERVER_STATE, {
          gameId,
          volumeId: liveVolume.volumeId,
          snapshotId,
          requestedAt: new Date().toISOString(),
        });
        pendingCleanupScheduled = true;
      } catch (err) {
        console.error('storePendingCleanup failed:', err);
      }
    }

    return {
      status: 'ok',
      instanceId: inst.instanceId,
      ...(snapshotId !== undefined ? { snapshotId } : {}),
      ...(liveVolume !== undefined ? { volumeId: liveVolume.volumeId } : {}),
      ...(snapshotFailed ? { snapshotFailed: true } : {}),
      pendingCleanupScheduled,
      dnsReset,
      dockerStopSucceeded,
    };
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // 成功・失敗を問わずロック解除 (異常 hang は TTL で自動失効するが先に消す)
    await env.SERVER_STATE.delete(lockKey).catch((err) =>
      console.error('release stop-in-progress lock failed:', err),
    );
  }
}

function wrapProgress(
  cb: RunStopWorkflowOptions['onProgress'],
): (message: string) => Promise<void> {
  return async (message: string): Promise<void> => {
    console.log(`[stop-workflow] ${message}`);
    if (cb === undefined) return;
    try {
      await cb(message);
    } catch (err) {
      console.error('stop-workflow onProgress callback failed:', err);
    }
  };
}
