// POST /sidecar/heartbeat — Worker に生存と player_count を伝える。
// Worker は KV `last-seen:<game_id>` を更新するだけで、idle 判定は sidecar 側が行う。

import { currentTimestamp, formatPostPayload, signHmac } from './hmac.js';

export interface HeartbeatOptions {
  workerUrl: string;
  gameId: string;
  instanceId: string;
  playerCount: number;
  secret: string;
}

export async function sendHeartbeat(opts: HeartbeatOptions): Promise<void> {
  const timestamp = currentTimestamp();
  const body = JSON.stringify({
    game_id: opts.gameId,
    instance_id: opts.instanceId,
    timestamp,
    player_count: opts.playerCount,
  });
  const payload = formatPostPayload(timestamp, body);
  const signature = await signHmac(payload, opts.secret);

  const res = await fetch(`${opts.workerUrl}/sidecar/heartbeat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sidecar-timestamp': String(timestamp),
      'x-sidecar-signature': signature,
    },
    body,
  });

  // 204 が正常。401/404 は Worker 側の認証 / registry 不整合で sidecar 側で訂正できないため
  // throw で持ち上げる (上位の loop が catch してログだけ出す方針)。
  if (res.status !== 204) {
    throw new Error(`heartbeat returned HTTP ${res.status}`);
  }
}
