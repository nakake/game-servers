// /start 〜 ready 通知の間、Discord interaction の文脈を一時保存する KV ヘルパ。
//
// 流れ:
//   1. /start ハンドラが interaction token / userId を KV に書く。
//   2. 後から非同期に届く SNS "<game_id> ready" 通知 (aws-notification ハンドラ) が
//      これを引き、/start の元メッセージを ✅ に編集し、起動した人を mention する。
//
// interaction token の有効期限は 15 分。KV TTL は余裕を見て 30 分にし、token 失効後でも
// userId を webhook フォールバック通知の mention に使えるようにしている。

export interface PendingReady {
  // follow-up message API のエンドポイント組み立て用。
  applicationId: string;
  interactionToken: string;
  gameId: string;
  // ready 通知に出す接続先。
  fqdn: string;
  port: number;
  // /start を叩いた人 (mention 対象)。DM 経由など取れない場合は undefined。
  userId?: string;
  // /start が実行された channel (デバッグ用)。
  channelId?: string;
  // ISO8601。経過時間のログ用。
  startedAt: string;
}

const KEY_PREFIX = 'pending-ready:';
// interaction token (15 分) 失効後のフォールバック余裕を見て 30 分。
const TTL_SECONDS = 1800;

function keyFor(gameId: string): string {
  return `${KEY_PREFIX}${gameId}`;
}

// /start 時に文脈を保存。同一ゲームの古い entry は上書きされる。
export async function storePendingReady(kv: KVNamespace, record: PendingReady): Promise<void> {
  await kv.put(keyFor(record.gameId), JSON.stringify(record), {
    expirationTtl: TTL_SECONDS,
  });
}

// ready 通知時に文脈を取得。未保存・TTL 切れ・壊れた JSON なら undefined。
export async function getPendingReady(
  kv: KVNamespace,
  gameId: string,
): Promise<PendingReady | undefined> {
  const raw = await kv.get(keyFor(gameId));
  if (raw === null) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as PendingReady;
  } catch {
    return undefined;
  }
}

// 配信完了後に削除 (TTL 切れを待たず、SNS 再送による二重通知を防ぐ)。
export async function deletePendingReady(kv: KVNamespace, gameId: string): Promise<void> {
  await kv.delete(keyFor(gameId));
}
