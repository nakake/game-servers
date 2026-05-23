import { describe, expect, it } from 'vitest';

import { formatGetPayload, formatPostPayload, signHmac } from '../../lib/auth/hmac.js';
import type { Env } from '../../env.js';
import { verifySidecarGetRequest, verifySidecarPostRequest } from './auth.js';

const SECRET = 'unit-secret-atm11-keep-stable';
const OTHER_SECRET = 'unit-secret-different';
const NOW = 1_700_000_000;

function makeEnv(secrets: Record<string, string>): Env {
  // テストでは SIDECAR_HMAC_SECRETS と GAME_REGISTRY の参照しか無いので最小モック。
  return {
    SIDECAR_HMAC_SECRETS: JSON.stringify(secrets),
  } as unknown as Env;
}

async function makeSignedPostRequest(opts: {
  body: string;
  timestamp: number;
  secret: string;
  url?: string;
}): Promise<Request> {
  const payload = formatPostPayload(opts.timestamp, opts.body);
  const signature = await signHmac(payload, opts.secret);
  return new Request(opts.url ?? 'https://worker.example/sidecar/heartbeat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sidecar-timestamp': String(opts.timestamp),
      'x-sidecar-signature': signature,
    },
    body: opts.body,
  });
}

async function makeSignedGetRequest(opts: {
  pathWithQuery: string;
  timestamp: number;
  secret: string;
}): Promise<Request> {
  const payload = formatGetPayload('GET', opts.pathWithQuery, opts.timestamp);
  const signature = await signHmac(payload, opts.secret);
  return new Request(`https://worker.example${opts.pathWithQuery}`, {
    method: 'GET',
    headers: {
      'x-sidecar-timestamp': String(opts.timestamp),
      'x-sidecar-signature': signature,
    },
  });
}

describe('verifySidecarPostRequest', () => {
  const env = makeEnv({ atm11: SECRET });
  const body = JSON.stringify({ game_id: 'atm11', instance_id: 'i-123', timestamp: NOW, player_count: 0 });

  it('accepts a correctly signed request', async () => {
    const req = await makeSignedPostRequest({ body, timestamp: NOW, secret: SECRET });
    const result = await verifySidecarPostRequest(req, env, NOW + 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.gameId).toBe('atm11');
      expect(result.body).toBe(body);
    }
  });

  it('rejects when X-Sidecar-Signature header is missing', async () => {
    const req = new Request('https://worker.example/sidecar/heartbeat', {
      method: 'POST',
      headers: { 'x-sidecar-timestamp': String(NOW) },
      body,
    });
    const result = await verifySidecarPostRequest(req, env, NOW);
    expect(result).toEqual({ ok: false, reason: 'missing-headers' });
  });

  it('rejects when timestamp header is non-numeric', async () => {
    const req = new Request('https://worker.example/sidecar/heartbeat', {
      method: 'POST',
      headers: {
        'x-sidecar-timestamp': 'not-a-number',
        'x-sidecar-signature': 'AAAA',
      },
      body,
    });
    const result = await verifySidecarPostRequest(req, env, NOW);
    expect(result).toEqual({ ok: false, reason: 'missing-headers' });
  });

  it('rejects when body is not valid JSON', async () => {
    const ts = NOW;
    const broken = '{not json';
    const sig = await signHmac(formatPostPayload(ts, broken), SECRET);
    const req = new Request('https://worker.example/sidecar/heartbeat', {
      method: 'POST',
      headers: {
        'x-sidecar-timestamp': String(ts),
        'x-sidecar-signature': sig,
      },
      body: broken,
    });
    const result = await verifySidecarPostRequest(req, env, ts);
    expect(result).toEqual({ ok: false, reason: 'invalid-body' });
  });

  it('rejects when body lacks game_id', async () => {
    const ts = NOW;
    const noGameBody = JSON.stringify({ instance_id: 'i-123' });
    const sig = await signHmac(formatPostPayload(ts, noGameBody), SECRET);
    const req = new Request('https://worker.example/sidecar/heartbeat', {
      method: 'POST',
      headers: {
        'x-sidecar-timestamp': String(ts),
        'x-sidecar-signature': sig,
      },
      body: noGameBody,
    });
    const result = await verifySidecarPostRequest(req, env, ts);
    expect(result).toEqual({ ok: false, reason: 'missing-game-id' });
  });

  it('rejects when game_id has no secret registered', async () => {
    const ts = NOW;
    const unknownBody = JSON.stringify({ game_id: 'vanilla', instance_id: 'i-456' });
    const sig = await signHmac(formatPostPayload(ts, unknownBody), SECRET);
    const req = new Request('https://worker.example/sidecar/heartbeat', {
      method: 'POST',
      headers: {
        'x-sidecar-timestamp': String(ts),
        'x-sidecar-signature': sig,
      },
      body: unknownBody,
    });
    const result = await verifySidecarPostRequest(req, env, ts);
    expect(result).toEqual({ ok: false, reason: 'unknown-game' });
  });

  it('rejects when the signature was produced with a different secret', async () => {
    const req = await makeSignedPostRequest({ body, timestamp: NOW, secret: OTHER_SECRET });
    const result = await verifySidecarPostRequest(req, env, NOW);
    expect(result).toEqual({ ok: false, reason: 'invalid-signature' });
  });

  it('rejects when the timestamp is outside the skew window', async () => {
    const req = await makeSignedPostRequest({ body, timestamp: NOW, secret: SECRET });
    const result = await verifySidecarPostRequest(req, env, NOW + 301);
    expect(result).toEqual({ ok: false, reason: 'invalid-signature' });
  });

  it('reports misconfigured-secrets when SIDECAR_HMAC_SECRETS is unparseable', async () => {
    const broken = { SIDECAR_HMAC_SECRETS: 'not-json' } as unknown as Env;
    const req = await makeSignedPostRequest({ body, timestamp: NOW, secret: SECRET });
    const result = await verifySidecarPostRequest(req, broken, NOW);
    expect(result).toEqual({ ok: false, reason: 'misconfigured-secrets' });
  });
});

describe('verifySidecarGetRequest', () => {
  const env = makeEnv({ atm11: SECRET });

  it('accepts a correctly signed registry GET', async () => {
    const path = '/sidecar/registry?game_id=atm11';
    const req = await makeSignedGetRequest({ pathWithQuery: path, timestamp: NOW, secret: SECRET });
    const result = await verifySidecarGetRequest(req, env, NOW + 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.gameId).toBe('atm11');
  });

  it('rejects when game_id query param is missing', async () => {
    const path = '/sidecar/registry';
    const req = await makeSignedGetRequest({ pathWithQuery: path, timestamp: NOW, secret: SECRET });
    const result = await verifySidecarGetRequest(req, env, NOW);
    expect(result).toEqual({ ok: false, reason: 'missing-game-id' });
  });

  it('rejects when the path is signed but tampered', async () => {
    const signedPath = '/sidecar/registry?game_id=atm11';
    const req = await makeSignedGetRequest({ pathWithQuery: signedPath, timestamp: NOW, secret: SECRET });
    // 受信側 URL を別物にすると payload が変わるため verify は失敗する。
    const tampered = new Request('https://worker.example/sidecar/registry?game_id=atm11&extra=1', {
      method: 'GET',
      headers: req.headers,
    });
    const result = await verifySidecarGetRequest(tampered, env, NOW);
    expect(result).toEqual({ ok: false, reason: 'invalid-signature' });
  });
});
