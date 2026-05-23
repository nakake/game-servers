import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shouldNotify } from './notif-suppress.js';

interface MockKvOpts {
  // 直近 put の options を観測 (TTL assertion 用)
  lastPutOptions?: KVNamespacePutOptions;
  // put を意図的に失敗させたい場合
  putFails?: boolean;
}

function createMockKv(opts: MockKvOpts = {}): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(
      key: string,
      value: string,
      putOpts?: KVNamespacePutOptions,
    ): Promise<void> {
      if (opts.putFails === true) {
        throw new Error('KV put failed (test injection)');
      }
      store.set(key, value);
      if (putOpts !== undefined) {
        opts.lastPutOptions = putOpts;
      }
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('shouldNotify', () => {
  it('returns true on first call and writes a suppression marker with the requested TTL', async () => {
    const opts: MockKvOpts = {};
    const kv = createMockKv(opts);
    const ok = await shouldNotify(kv, 'snapshot-retention:atm11', 3600);
    expect(ok).toBe(true);
    expect(opts.lastPutOptions?.expirationTtl).toBe(3600);
  });

  it('returns false on subsequent calls within the TTL window (連投抑制)', async () => {
    const kv = createMockKv();
    expect(await shouldNotify(kv, 'volume-cleanup:vol-x', 3600)).toBe(true);
    expect(await shouldNotify(kv, 'volume-cleanup:vol-x', 3600)).toBe(false);
    expect(await shouldNotify(kv, 'volume-cleanup:vol-x', 3600)).toBe(false);
  });

  it('treats different suppress keys independently (per-resource granularity)', async () => {
    const kv = createMockKv();
    expect(await shouldNotify(kv, 'snapshot-retention:atm11', 3600)).toBe(true);
    expect(await shouldNotify(kv, 'snapshot-retention:vanilla', 3600)).toBe(true);
    // 同じ key だけ抑制される、別 key は独立
    expect(await shouldNotify(kv, 'snapshot-retention:atm11', 3600)).toBe(false);
    expect(await shouldNotify(kv, 'snapshot-retention:vanilla', 3600)).toBe(false);
  });

  it('clamps ttlSeconds below 60 to 60 and warns (KV TTL の下限保護)', async () => {
    const opts: MockKvOpts = {};
    const kv = createMockKv(opts);
    await shouldNotify(kv, 'test:k', 30);
    expect(opts.lastPutOptions?.expirationTtl).toBe(60);
    expect(console.warn).toHaveBeenCalled();
  });

  it('handles non-finite ttlSeconds (NaN / Infinity) by clamping to 60', async () => {
    const opts: MockKvOpts = {};
    const kv = createMockKv(opts);
    await shouldNotify(kv, 'test:k', Number.NaN);
    expect(opts.lastPutOptions?.expirationTtl).toBe(60);
  });

  it('returns true even when KV put fails (= 通知優先、抑制が効かないだけ)', async () => {
    const kv = createMockKv({ putFails: true });
    const ok = await shouldNotify(kv, 'test:k', 3600);
    expect(ok).toBe(true);
    expect(console.warn).toHaveBeenCalled();
  });

  it('uses the notif-suppress: key prefix (avoid collision with other namespaces)', async () => {
    const opts: MockKvOpts = {};
    const kv = createMockKv(opts);
    let lastPutKey: string | undefined;
    const origPut = kv.put.bind(kv);
    kv.put = async (
      key: string,
      value: string,
      putOpts?: KVNamespacePutOptions,
    ): Promise<void> => {
      lastPutKey = key;
      await origPut(key, value, putOpts);
    };
    await shouldNotify(kv, 'snapshot-retention:atm11', 3600);
    expect(lastPutKey).toBe('notif-suppress:snapshot-retention:atm11');
  });
});
