// Sidecar heartbeat の最新観測値を SERVER_STATE KV に保持する (Phase 3、docs/phase3-plan.md)。
//
// 用途:
//   - sidecar が `/sidecar/heartbeat` を打つたびに上書き (instance_id / player_count / 観測時刻)
//   - Cron フォールバック (Step 3) が「`now - last_seen_at > timeout_min + 5min` なら強制停止」
//     の判定で読む
//
// TTL は呼び出し側 (handlers/sidecar/heartbeat.ts) が registry の `idle_check.timeout_min` から
// 算出する (`timeout_min * 60 * 3`)。**この余裕分**があるため、フォールバック判定で「キーが
// 無い」= 「sidecar が一度も heartbeat してこなかった + 起動から timeout_min*3 を超えた」と
// 解釈できる。起動直後の grace 期間 (heartbeat 未着) で誤停止しないための保険。
//
// キーは gameId 単位。複数 game 同時運用 (将来) に備える。

export interface SidecarLastSeen {
  gameId: string;
  // sidecar が動いている instance。古い instance からの晩到 heartbeat を区別するため記録する。
  instanceId: string;
  // ISO8601。sidecar が観測した時刻を Worker 側のタイムスタンプで上書き保存する
  // (sidecar の wall clock を信頼しないため Worker の Date.now を使う)。
  lastSeenAt: string;
  // sidecar が観測した player count。フォールバック判定で参照する。
  playerCount: number;
}

const KEY_PREFIX = 'last-seen:';

function keyFor(gameId: string): string {
  return `${KEY_PREFIX}${gameId}`;
}

export async function storeLastSeen(
  kv: KVNamespace,
  record: SidecarLastSeen,
  ttlSec: number,
): Promise<void> {
  await kv.put(keyFor(record.gameId), JSON.stringify(record), {
    expirationTtl: ttlSec,
  });
}

export async function getLastSeen(
  kv: KVNamespace,
  gameId: string,
): Promise<SidecarLastSeen | undefined> {
  const raw = await kv.get(keyFor(gameId));
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as SidecarLastSeen;
  } catch {
    return undefined;
  }
}

// /stop 後に Cron フォールバックが古い entry を見続けるのを防ぐため、明示削除も用意する
// (TTL 任せでも安全だが、即削除した方が判定の単純化になる)。
export async function deleteLastSeen(kv: KVNamespace, gameId: string): Promise<void> {
  await kv.delete(keyFor(gameId));
}
