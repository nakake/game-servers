// Cron Trigger ハンドラ — game-world snapshot を registry の snapshot.generations 世代に絞る。
//
// なぜ Worker 側で世代管理するか:
//   当初は AWS DLM (Data Lifecycle Manager) に委譲する想定だった (design.md §5.5) が、DLM の
//   EBS スナップショット管理ポリシーは「DLM 自身がスケジュールで作成した snapshot」しか保持・
//   削除しない。`/stop` フロー (handlers/discord/stop.ts) は Worker が CreateSnapshot で
//   snapshot を作るため、target_tags が一致しても DLM の管理対象に入らない。よって世代管理は
//   Worker 側で行う (docs/iac-migration-plan.md Step 6)。
//
// 対象の絞り込み: `/stop` が付ける snapshot 専用マーカー (SnapshotType=game-world-data) を必須
//   フィルタにする。これは volume / root volume には決して付かないので、root クローン等を
//   誤って世代管理対象に巻き込まない (ebs.ts の GAME_WORLD_SNAPSHOT_TAG_* 参照)。
//
// 安全側の判定: completed な snapshot だけを数えて世代を超えた分を消す。`/stop` 直後の最新
//   snapshot は pending 状態なので、これが completed になるまでは削除を 1 tick 見送る。これに
//   より「有効な (completed) 世代数が generations を下回る」ことが起きない。error 状態の
//   snapshot は数にも削除対象にも入れず、ログだけ残して手動対応に倒す。
//
// 冪等性: 各 tick は Game ごとに completed snapshot を startTime 降順で並べ、generations 本目
//   より古いものを DeleteSnapshot するだけ。何度走らせても残る本数は generations に収束する。

import {
  AwsApiClient,
  deleteSnapshot,
  describeSnapshotsByTag,
  GAME_WORLD_SNAPSHOT_TAG_KEY,
  GAME_WORLD_SNAPSHOT_TAG_VALUE,
} from '../lib/aws/index.js';
import { allGames } from '../lib/registry/atm11.js';
import type { Env } from '../env.js';

export async function handleSnapshotRetention(env: Env): Promise<void> {
  const ec2 = new AwsApiClient({
    region: env.AWS_REGION ?? 'ap-northeast-1',
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  for (const game of allGames) {
    const generations = game.snapshot.generations;
    if (!Number.isInteger(generations) || generations < 1) {
      console.warn(
        `snapshot retention: ${game.game_id} has invalid snapshot.generations=` +
          `${String(generations)} — skip`,
      );
      continue;
    }

    try {
      // Game + game-world data マーカーで対象 snapshot を取得。describeSnapshotsByTag は
      // Owner=self を強制するので他人の snapshot は混ざらない。
      const snaps = await describeSnapshotsByTag(ec2, {
        Game: game.game_id,
        [GAME_WORLD_SNAPSHOT_TAG_KEY]: GAME_WORLD_SNAPSHOT_TAG_VALUE,
      });

      // completed のみを世代カウントの対象にする (pending = `/stop` 直後の最新分は次 tick へ、
      // error = 手動対応に倒す)。startTime は ISO8601 なので文字列比較で降順に並ぶ。
      const completed = snaps
        .filter((s) => s.state === 'completed')
        .sort((a, b) => (a.startTime < b.startTime ? 1 : -1));

      const stale = completed.slice(generations);
      if (stale.length === 0) continue;

      for (const snap of stale) {
        await deleteSnapshot(ec2, snap.snapshotId);
        console.log(
          `snapshot retention: deleted ${snap.snapshotId} for ${game.game_id} ` +
            `(startTime=${snap.startTime}, keep newest ${String(generations)})`,
        );
      }
    } catch (err) {
      // 1 ゲームの失敗で他ゲームを巻き込まない。次 tick で再試行される。
      console.error(`snapshot retention: failed for ${game.game_id}:`, err);
    }
  }
}
