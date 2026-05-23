// Worker `/sidecar/registry?game_id=<id>` から GameDefinition を取得する。
//
// Worker (KV) を single source of truth に保つ設計 (docs/phase3-plan.md 決定8)。
// sidecar 起動時に 1 回呼び、`idle_check` の仕様を取得する。enabled=false / 未登録は
// Worker が 404 で返す → sidecar は exit して container 終了 (`--restart` 設定次第で再起動)。

import { currentTimestamp, formatGetPayload, signHmac } from './hmac.js';

// 必要なフィールドだけを Pick した型。Worker 側の GameDefinition 全フィールドを sidecar が
// 再宣言する必要はない (responsibility separation)。
export interface SidecarGameDefinition {
  game_id: string;
  enabled: boolean;
  idle_check: {
    type: string;
    timeout_min: number;
    heartbeat_interval_sec?: number;
    config: Record<string, unknown>;
  };
}

export async function fetchRegistry(opts: {
  workerUrl: string;
  gameId: string;
  secret: string;
}): Promise<SidecarGameDefinition> {
  const timestamp = currentTimestamp();
  const pathWithQuery = `/sidecar/registry?game_id=${encodeURIComponent(opts.gameId)}`;
  const payload = formatGetPayload('GET', pathWithQuery, timestamp);
  const signature = await signHmac(payload, opts.secret);

  const res = await fetch(`${opts.workerUrl}${pathWithQuery}`, {
    method: 'GET',
    headers: {
      'x-sidecar-timestamp': String(timestamp),
      'x-sidecar-signature': signature,
    },
  });

  if (!res.ok) {
    throw new Error(`Worker /sidecar/registry returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as SidecarGameDefinition;
  if (typeof body.idle_check?.timeout_min !== 'number') {
    throw new Error('registry response missing idle_check.timeout_min');
  }
  return body;
}
