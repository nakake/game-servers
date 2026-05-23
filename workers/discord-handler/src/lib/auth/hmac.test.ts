import { describe, it, expect } from 'vitest';

import {
  formatGetPayload,
  formatPostPayload,
  signHmac,
  verifyHmac,
} from './hmac.js';

const SECRET = 'unit-test-secret-keep-stable-please';
const OTHER_SECRET = 'unit-test-different-secret-value';
const NOW = 1_700_000_000;

describe('formatPostPayload', () => {
  it('joins timestamp and body with a single LF', () => {
    expect(formatPostPayload(NOW, '{"x":1}')).toBe(`${NOW}\n{"x":1}`);
  });

  it('preserves body bytes verbatim (no JSON re-encoding)', () => {
    // sidecar が送ったそのままを payload に取ること。空白も含めて改変しない契約。
    const body = '{ "padded" : 1 }';
    expect(formatPostPayload(NOW, body)).toBe(`${NOW}\n${body}`);
  });
});

describe('formatGetPayload', () => {
  it('uppercases the method and joins with LFs', () => {
    expect(formatGetPayload('get', '/sidecar/registry?game_id=atm11', NOW)).toBe(
      `GET\n/sidecar/registry?game_id=atm11\n${NOW}`,
    );
  });
});

describe('verifyHmac', () => {
  it('accepts a valid signature within the skew window', async () => {
    const payload = formatPostPayload(NOW, '{"hello":"world"}');
    const signature = await signHmac(payload, SECRET);
    const ok = await verifyHmac({
      payload,
      signature,
      secret: SECRET,
      timestamp: NOW,
      now: NOW + 30,
    });
    expect(ok).toBe(true);
  });

  it('accepts a request right at the skew boundary', async () => {
    const payload = formatPostPayload(NOW, '{}');
    const signature = await signHmac(payload, SECRET);
    const ok = await verifyHmac({
      payload,
      signature,
      secret: SECRET,
      timestamp: NOW,
      now: NOW + 300,
    });
    expect(ok).toBe(true);
  });

  it('rejects a request just outside the skew window', async () => {
    const payload = formatPostPayload(NOW, '{}');
    const signature = await signHmac(payload, SECRET);
    const ok = await verifyHmac({
      payload,
      signature,
      secret: SECRET,
      timestamp: NOW,
      now: NOW + 301,
    });
    expect(ok).toBe(false);
  });

  it('rejects a tampered body even with the original signature', async () => {
    const original = formatPostPayload(NOW, '{"hello":"world"}');
    const signature = await signHmac(original, SECRET);
    const tampered = formatPostPayload(NOW, '{"hello":"WORLD"}');
    const ok = await verifyHmac({
      payload: tampered,
      signature,
      secret: SECRET,
      timestamp: NOW,
      now: NOW + 1,
    });
    expect(ok).toBe(false);
  });

  it('rejects a signature produced with a different secret', async () => {
    const payload = formatPostPayload(NOW, '{}');
    const signature = await signHmac(payload, OTHER_SECRET);
    const ok = await verifyHmac({
      payload,
      signature,
      secret: SECRET,
      timestamp: NOW,
      now: NOW + 1,
    });
    expect(ok).toBe(false);
  });

  it('rejects malformed base64 signatures without throwing', async () => {
    const ok = await verifyHmac({
      payload: 'whatever',
      signature: '!!!not-base64!!!',
      secret: SECRET,
      timestamp: NOW,
      now: NOW,
    });
    expect(ok).toBe(false);
  });

  it('accepts GET-style payloads when sidecar and Worker agree on normalization', async () => {
    const payload = formatGetPayload('GET', '/sidecar/registry?game_id=atm11', NOW);
    const signature = await signHmac(payload, SECRET);
    const ok = await verifyHmac({
      payload,
      signature,
      secret: SECRET,
      timestamp: NOW,
      now: NOW + 5,
    });
    expect(ok).toBe(true);
  });
});
