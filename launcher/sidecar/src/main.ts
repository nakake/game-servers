// sidecar エントリポイント (Phase 3 Step 4)。
//
// 起動フロー:
//   1. env (`GAME_ID` / `WORKER_URL`) を読む。
//   2. IMDSv2 で `instance_id` を取得する。
//   3. SSM SecureString `/gs/<game_id>/sidecar_hmac_secret` を取得する。
//   4. Worker `/sidecar/registry` で GameDefinition を取得する。enabled=false なら exit。
//   5. registry の `idle_check.config.password_source` を SSM から取得 (RCON password 等)。
//   6. adapter を `idle_check.type` で選ぶ。
//   7. メインループに入り、`heartbeat_interval_sec` ごとに adapter.check → heartbeat → idle 判定。

import { getAdapter } from './adapters/index.js';
import { sendHeartbeat } from './heartbeat.js';
import { sendIdleDetected } from './idle-notify.js';
import { getInstanceId } from './imds.js';
import { evaluateTick, type LoopState } from './loop.js';
import { log } from './logger.js';
import { fetchRegistry } from './registry.js';
import { getSecureParameter } from './ssm.js';

// idle 通知後の cooldown。Worker は ctx.waitUntil で stop ワークフローを起動するため
// 通常は 30〜60 秒で sidecar 自体が terminate される。念のため 5 分の cooldown で重複発火を避ける。
const POST_NOTIFY_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_SEC = 60;

function required(key: string): string {
  const v = process.env[key];
  if (v === undefined || v.length === 0) {
    throw new Error(`env ${key} is required`);
  }
  return v;
}

async function main(): Promise<void> {
  const gameId = required('GAME_ID');
  const workerUrl = required('WORKER_URL').replace(/\/$/, '');

  log.info('starting', { gameId, workerUrl });

  const instanceId = await getInstanceId();
  log.info('instance_id resolved', { instanceId });

  const hmacSecret = await getSecureParameter(`/gs/${gameId}/sidecar_hmac_secret`);

  const game = await fetchRegistry({ workerUrl, gameId, secret: hmacSecret });
  if (!game.enabled) {
    log.error('game is disabled in registry, exiting', { gameId });
    process.exit(1);
  }

  const intervalSec =
    typeof game.idle_check.heartbeat_interval_sec === 'number'
      ? game.idle_check.heartbeat_interval_sec
      : DEFAULT_HEARTBEAT_INTERVAL_SEC;
  const idleTimeoutMs = game.idle_check.timeout_min * 60_000;
  log.info('registry loaded', {
    type: game.idle_check.type,
    timeoutMin: game.idle_check.timeout_min,
    intervalSec,
  });

  // RCON 等の追加 secret を SSM から取得 (config.password_source が ssm:<path> なら参照)。
  const pwSrcRaw = game.idle_check.config['password_source'];
  let adapterPassword = '';
  if (typeof pwSrcRaw === 'string' && pwSrcRaw.startsWith('ssm:')) {
    adapterPassword = await getSecureParameter(pwSrcRaw.slice('ssm:'.length));
    log.info('adapter password loaded from SSM', { source: pwSrcRaw });
  }

  const adapter = getAdapter(game.idle_check.type);

  const state: LoopState = {
    lastNonIdleMs: Date.now(),
    lastNotifiedMs: 0,
  };

  // 強制終了 (SIGTERM / SIGINT) でループを抜けるためのフラグ。
  let running = true;
  const stop = (signal: string): void => {
    log.info('shutdown signal received', { signal });
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (running) {
    const tickStart = Date.now();

    let result: { playerCount: number; idle: boolean } | null = null;
    try {
      result = await adapter.check({
        config: game.idle_check.config,
        password: adapterPassword,
      });
    } catch (err) {
      log.warn('adapter check failed', { error: errorMessage(err) });
    }

    const decision = evaluateTick(state, {
      result,
      now: Date.now(),
      idleTimeoutMs,
      postNotifyCooldownMs: POST_NOTIFY_COOLDOWN_MS,
    });

    try {
      await sendHeartbeat({
        workerUrl,
        gameId,
        instanceId,
        playerCount: decision.heartbeatPlayerCount,
        secret: hmacSecret,
      });
    } catch (err) {
      log.warn('heartbeat failed', { error: errorMessage(err) });
    }

    if (decision.shouldNotifyIdle) {
      log.warn('idle detected — notifying Worker', {
        elapsedMin: Math.round((Date.now() - state.lastNonIdleMs) / 60_000),
      });
      try {
        await sendIdleDetected({
          workerUrl,
          gameId,
          instanceId,
          lastPlayerSeenAt: new Date(state.lastNonIdleMs).toISOString(),
          secret: hmacSecret,
        });
        state.lastNotifiedMs = Date.now();
      } catch (err) {
        log.error('idle-detected POST failed', { error: errorMessage(err) });
      }
    }

    // 次の tick まで待つ (実 tick 処理時間を差し引く)。最低 1 秒は休む。
    const elapsed = Date.now() - tickStart;
    const sleepMs = Math.max(1_000, intervalSec * 1_000 - elapsed);
    await sleep(sleepMs);
  }

  log.info('main loop exited');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  log.error('fatal', { error: errorMessage(err) });
  process.exit(1);
});
