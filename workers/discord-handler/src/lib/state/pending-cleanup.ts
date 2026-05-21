// `/stop` が作った snapshot の完成を待って data volume を削除するための deferred 状態。
//
// なぜ KV に逃がすか:
//   EBS snapshot の完成は数分かかる。Worker の 1 invocation はそんなに長く生きられない
//   (実行時間制限で途中 kill される) ため、`/stop` の中で snapshot 完成を待って volume を
//   消す設計は破綻する。代わりに `/stop` は「あとで消す volume」をここに記録するだけにし、
//   Cron Trigger (handlers/cleanup.ts) が snapshot completed を確認して削除する。
//
// キーは volumeId 単位。1 ゲームでも /stop を続けて打てば複数の cleanup が並ぶため、
// gameId ではなく volumeId を一意キーにする。

export interface PendingCleanup {
  gameId: string;
  // 削除対象の data volume。
  volumeId: string;
  // 完成を待つ snapshot。completed を確認してから volume を消す。
  snapshotId: string;
  // ISO8601。/stop が記録した時刻。
  requestedAt: string;
}

const KEY_PREFIX = 'pending-cleanup:';
// snapshot 完成は通常数分。異常系で完成せず無限に残るのを避けるため 24h TTL。
const TTL_SECONDS = 86400;

function keyFor(volumeId: string): string {
  return `${KEY_PREFIX}${volumeId}`;
}

// /stop が「snapshot 完成後に消す volume」を記録する。
export async function storePendingCleanup(kv: KVNamespace, record: PendingCleanup): Promise<void> {
  await kv.put(keyFor(record.volumeId), JSON.stringify(record), {
    expirationTtl: TTL_SECONDS,
  });
}

// Cron が未処理の cleanup を全件取得する。壊れた entry は無視する (TTL でいずれ消える)。
export async function listPendingCleanups(kv: KVNamespace): Promise<PendingCleanup[]> {
  const out: PendingCleanup[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({
      prefix: KEY_PREFIX,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      if (raw === null) continue;
      try {
        out.push(JSON.parse(raw) as PendingCleanup);
      } catch {
        // 壊れた JSON は読み飛ばす。
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  return out;
}

// 削除完了 (または再試行不要) になった entry を消す。
export async function deletePendingCleanup(kv: KVNamespace, volumeId: string): Promise<void> {
  await kv.delete(keyFor(volumeId));
}
