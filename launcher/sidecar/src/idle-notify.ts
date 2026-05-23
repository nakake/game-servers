// POST /sidecar/idle-detected — `timeout_min` を超えて player 0 が続いた時に通知する。
// Worker 側で runStopWorkflow が走り、snapshot + terminate が発火する。sidecar は数十秒以内に
// terminate されるため、二重発火しないよう loop 側で flag を立てて重複送信を抑える。

import { currentTimestamp, formatPostPayload, signHmac } from './hmac.js';

export interface IdleNotifyOptions {
  workerUrl: string;
  gameId: string;
  instanceId: string;
  lastPlayerSeenAt: string; // ISO8601
  secret: string;
}

export async function sendIdleDetected(opts: IdleNotifyOptions): Promise<void> {
  const timestamp = currentTimestamp();
  const body = JSON.stringify({
    game_id: opts.gameId,
    instance_id: opts.instanceId,
    timestamp,
    last_player_seen_at: opts.lastPlayerSeenAt,
  });
  const payload = formatPostPayload(timestamp, body);
  const signature = await signHmac(payload, opts.secret);

  const res = await fetch(`${opts.workerUrl}/sidecar/idle-detected`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sidecar-timestamp': String(timestamp),
      'x-sidecar-signature': signature,
    },
    body,
  });

  if (res.status !== 202) {
    throw new Error(`idle-detected returned HTTP ${res.status}`);
  }
}
