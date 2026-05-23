import { describe, expect, it } from 'vitest';

import { formatGetPayload, formatPostPayload, signHmac } from './hmac.js';

// Worker 側 (workers/discord-handler/src/lib/auth/hmac.ts) と相互互換であることを担保するため、
// 同じ仕様で動くことを sidecar 側の単体テストでも確認する。本当の相互運用は Step 8 (実機) で
// `/sidecar/heartbeat` が 204 を返すことで確認される。

const SECRET = 'unit-secret-atm11-keep-stable';
const NOW = 1_700_000_000;

describe('formatPostPayload', () => {
  it('joins timestamp and body with single LF', () => {
    expect(formatPostPayload(NOW, '{"x":1}')).toBe(`${NOW}\n{"x":1}`);
  });

  it('preserves body bytes verbatim', () => {
    const body = '{ "padded" : 1 }';
    expect(formatPostPayload(NOW, body)).toBe(`${NOW}\n${body}`);
  });
});

describe('formatGetPayload', () => {
  it('uppercases method and joins with LFs', () => {
    expect(formatGetPayload('get', '/sidecar/registry?game_id=atm11', NOW)).toBe(
      `GET\n/sidecar/registry?game_id=atm11\n${NOW}`,
    );
  });
});

describe('signHmac', () => {
  it('produces deterministic base64 for stable inputs', async () => {
    const sig1 = await signHmac('hello\nworld', SECRET);
    const sig2 = await signHmac('hello\nworld', SECRET);
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('changes when secret changes', async () => {
    const a = await signHmac('payload', 'secret-1');
    const b = await signHmac('payload', 'secret-2');
    expect(a).not.toBe(b);
  });

  it('changes when payload changes', async () => {
    const a = await signHmac('payload-a', SECRET);
    const b = await signHmac('payload-b', SECRET);
    expect(a).not.toBe(b);
  });
});
