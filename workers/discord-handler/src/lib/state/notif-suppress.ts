// 通知連投抑制 — TTL ベースの「同じ event を一定時間 1 回しか通知しない」guard (Phase 4)。
//
// 用途: Cron Trigger (snapshot-retention / volume-cleanup) のように 5 分間隔で走るループで
// AWS API 失敗が継続発生した場合、毎 tick 通知すると Discord が溢れる。1 時間 1 回に絞る。
//
// 仕組み:
//   - `notif-suppress:<key>` に dummy 値 ('1') を TTL 付きで put する。
//   - put 前に get して存在チェック。存在すれば「最近通知済」とみなして false (= 通知しない)。
//   - 存在しなければ put して true (= 通知する) を返す。
//
// KV の eventual consistency により厳密な at-most-once は保証されないが、Cron は同じ Worker
// region から走るため実用上は十分な精度で抑制できる (前 tick の put がほぼ即時 read 可能)。
//
// 設計上の制限:
//   - 同じ key で並行ループした場合 race condition で 2 回通知される可能性はある (read-then-put
//     が atomic ではないため)。本ユースケース (5 分間隔 Cron) では発生し得ない。
//   - put が失敗しても呼び出し側は通知する判断を返す (= silent fail で抑制が効かない可能性)。
//     通知が漏れるよりは溢れる方が運用上マシ、という判断。

const KEY_PREFIX = 'notif-suppress:';

// suppressKey 例: 'snapshot-retention:atm11' / 'volume-cleanup:vol-deadbeef'
// 同じ suppressKey に対して ttlSeconds 内に複数回呼ばれた場合、初回だけ true を返す。
//
// 戻り値の解釈:
//   true  → 「通知してよい」(連投ウィンドウの初回 or TTL 切れ後)
//   false → 「通知抑制中」(同じ key で前回通知から ttlSeconds 経過していない)
export async function shouldNotify(
  kv: KVNamespace,
  suppressKey: string,
  ttlSeconds: number,
): Promise<boolean> {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60) {
    // KV TTL の下限は 60 秒。それより短いと put が ValidationException で落ちる。
    // 呼び出し側のミスを検知するため throw ではなく早期 return + warn にする (通知優先)。
    console.warn(`shouldNotify: ttlSeconds ${ttlSeconds} < 60, falling back to 60`);
    ttlSeconds = 60;
  }

  const key = `${KEY_PREFIX}${suppressKey}`;
  const existing = await kv.get(key);
  if (existing !== null) {
    return false;
  }

  try {
    await kv.put(key, '1', { expirationTtl: ttlSeconds });
  } catch (err) {
    // 抑制マーカー put 失敗は致命的ではない (この tick で重複通知されるだけ)。warn ログのみ。
    console.warn(`shouldNotify: failed to put suppression marker ${key}:`, err);
  }
  return true;
}
