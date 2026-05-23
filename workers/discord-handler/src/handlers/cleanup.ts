// Cron Trigger ハンドラ — `/stop` が予約した「snapshot 完成後に削除する volume」を回収する。
//
// なぜ Cron か:
//   EBS snapshot の完成は数分かかる。Worker の 1 invocation はそんなに長く生きられない
//   (実行時間制限で途中 kill される) ため、`/stop` 内で snapshot 完成を待って volume を消す
//   設計は破綻する。代わりに `/stop` は KV (pending-cleanup) に予約を書くだけにし、この
//   Cron が定期的に snapshot completed を確認して volume を削除する。
//
// 冪等性: 各 tick は KV の pending-cleanup を読み、completed のものだけ削除して entry を消す。
// まだ pending のものは次 tick に持ち越す。途中で失敗しても entry が残るので次 tick で再試行
// される。entry を消すのは「削除完了」「snapshot error で手動対応に倒す」「対象が既に無い」のみ。

import {
  AwsApiClient,
  deleteVolume,
  describeSnapshotById,
  describeVolumeById,
} from '../lib/aws/index.js';
import { buildCronFailureNotification } from '../lib/discord/notifications.js';
import { postDiscordWebhookMessage } from '../lib/discord/webhook.js';
import { deletePendingCleanup, listPendingCleanups, type PendingCleanup } from '../lib/state/pending-cleanup.js';
import { shouldNotify } from '../lib/state/notif-suppress.js';
import type { Env } from '../env.js';

// 同一 volume の失敗は 1 時間 1 回まで通知 (Cron は 5 分間隔)。
const FAILURE_NOTIFY_TTL_SECONDS = 3600;

export async function handleVolumeCleanup(env: Env): Promise<void> {
  const kv = env.SERVER_STATE;
  const pending = await listPendingCleanups(kv);
  if (pending.length === 0) return;

  const ec2 = new AwsApiClient({
    region: env.AWS_REGION ?? 'ap-northeast-1',
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  for (const entry of pending) {
    try {
      const snap = await describeSnapshotById(ec2, entry.snapshotId);

      // snapshot が見当たらない (誤記録 or 既に削除済)。再試行しても無意味なので entry を消す。
      if (snap === undefined) {
        console.warn(
          `volume cleanup: snapshot ${entry.snapshotId} not found — dropping entry for ${entry.volumeId}`,
        );
        await deletePendingCleanup(kv, entry.volumeId);
        continue;
      }

      // snapshot 失敗。volume は唯一のコピーなので消さない。毎 tick ログが出ないよう entry は
      // 消し、手動対応に倒す。Discord にも通知してユーザーが気づけるようにする。
      if (snap.state === 'error') {
        console.error(
          `volume cleanup: snapshot ${entry.snapshotId} is in "error" state — ` +
            `keeping volume ${entry.volumeId} for manual handling`,
        );
        await notifyCleanupFailure(env, entry, 'snapshot-error-state',
          `snapshot ${entry.snapshotId} entered AWS error state`,
        ).catch((err) => console.error('cleanup notify failed:', err));
        await deletePendingCleanup(kv, entry.volumeId);
        continue;
      }

      // まだ完成していない (pending / recovering)。次 tick で再判定。
      if (snap.state !== 'completed' && snap.state !== 'recoverable') {
        continue;
      }

      // snapshot は完成。volume の状態を見て削除する。
      const vol = await describeVolumeById(ec2, entry.volumeId);
      if (vol === undefined || vol.state === 'deleted' || vol.state === 'deleting') {
        // 既に消えている。entry だけ片付ける。
        await deletePendingCleanup(kv, entry.volumeId);
        continue;
      }
      if (vol.state !== 'available') {
        // instance terminate 直後で in-use のまま等。次 tick で再判定。
        continue;
      }

      await deleteVolume(ec2, entry.volumeId);
      await deletePendingCleanup(kv, entry.volumeId);
      console.log(
        `volume cleanup: deleted volume ${entry.volumeId} (snapshot ${entry.snapshotId} completed)`,
      );
    } catch (err) {
      // entry は残す → 次 tick で再試行。Discord にも通知 (1 時間 1 回まで)。
      console.error(`volume cleanup: failed for volume ${entry.volumeId}:`, err);
      await notifyCleanupFailure(env, entry, 'aws-error',
        err instanceof Error ? err.message : String(err),
      ).catch((notifyErr) => console.error('cleanup notify failed:', notifyErr));
    }
  }
}

// Discord webhook で volume cleanup の失敗を通知する。1 時間 1 回まで (volume 単位)。
// volume と snapshot が違うので suppress key は volumeId にする (snapshot が error 状態のときも
// 同じ key で抑制すれば、aws-error 経路と二重通知を避けられる)。
async function notifyCleanupFailure(
  env: Env,
  entry: PendingCleanup,
  reason: 'aws-error' | 'snapshot-error-state',
  errorMessage: string,
): Promise<void> {
  const ok = await shouldNotify(
    env.SERVER_STATE,
    `volume-cleanup:${entry.volumeId}`,
    FAILURE_NOTIFY_TTL_SECONDS,
  );
  if (!ok) return;

  const embed = buildCronFailureNotification({
    eventType: 'volume-cleanup',
    gameId: entry.gameId,
    resourceId: entry.volumeId,
    reason,
    errorMessage,
  });
  await postDiscordWebhookMessage(env, { embeds: [embed] });
}
