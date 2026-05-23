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
import { deletePendingCleanup, listPendingCleanups } from '../lib/state/pending-cleanup.js';
import type { Env } from '../env.js';

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
      // 消し、手動対応に倒す。
      if (snap.state === 'error') {
        console.error(
          `volume cleanup: snapshot ${entry.snapshotId} is in "error" state — ` +
            `keeping volume ${entry.volumeId} for manual handling`,
        );
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
      // entry は残す → 次 tick で再試行。
      console.error(`volume cleanup: failed for volume ${entry.volumeId}:`, err);
    }
  }
}
