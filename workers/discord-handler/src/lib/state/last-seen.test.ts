import { describe, expect, it } from 'vitest';

import { deleteLastSeen, getLastSeen, storeLastSeen, type SidecarLastSeen } from './last-seen.js';

interface MockKvOpts {
  // TTL を観測したいテスト向け (Step 3 で `expirationTtl` 連携を確認するため一応持つ)。
  lastPutOptions?: KVNamespacePutOptions;
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

const RECORD: SidecarLastSeen = {
  gameId: 'atm11',
  instanceId: 'i-deadbeef',
  lastSeenAt: '2026-05-23T12:00:00.000Z',
  playerCount: 2,
};

describe('storeLastSeen / getLastSeen', () => {
  it('round-trips a record under the namespaced key', async () => {
    const opts: MockKvOpts = {};
    const kv = createMockKv(opts);
    await storeLastSeen(kv, RECORD, 1800);
    const out = await getLastSeen(kv, 'atm11');
    expect(out).toEqual(RECORD);
    expect(opts.lastPutOptions?.expirationTtl).toBe(1800);
  });

  it('returns undefined when key is absent', async () => {
    const kv = createMockKv();
    expect(await getLastSeen(kv, 'atm11')).toBeUndefined();
  });

  it('returns undefined when stored JSON is broken (defensive)', async () => {
    const kv = createMockKv();
    // 故意に壊れた JSON を直接書き込み、デコード失敗時の挙動を確認する。
    await kv.put('last-seen:atm11', '{not json');
    expect(await getLastSeen(kv, 'atm11')).toBeUndefined();
  });

  it('deletes the entry on demand', async () => {
    const kv = createMockKv();
    await storeLastSeen(kv, RECORD, 60);
    await deleteLastSeen(kv, 'atm11');
    expect(await getLastSeen(kv, 'atm11')).toBeUndefined();
  });
});
