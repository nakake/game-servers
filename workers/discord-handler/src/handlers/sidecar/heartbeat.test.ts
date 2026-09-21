// handlers/sidecar/heartbeat.ts のテスト。
//
// auth.js (HMAC 検証) だけを差し替え、KV は in-memory Map モックにする (store.test.ts と同じ作り)。
// heartbeat が last-seen を更新しつつ registry-index を自己修復すること、index の get が失敗しても
// 204 を返して last-seen は書かれていることを確認する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth.js', () => ({ verifySidecarPostRequest: vi.fn() }));

import { REGISTRY_INDEX_KEY } from '@gs/shared/registry-index';

import { verifySidecarPostRequest } from './auth.js';
import { handleSidecarHeartbeat } from './heartbeat.js';
import type { GameDefinition } from '../../lib/registry/types.js';
import type { Env } from '../../env.js';

// put の第 3 引数 (expirationTtl) まで記録する KV モック (store.test.ts と同じ)。
interface PutCall {
  key: string;
  value: string;
  options: KVNamespacePutOptions | undefined;
}

interface KvMock {
  kv: KVNamespace;
  store: Map<string, string>;
  puts: PutCall[];
  list: ReturnType<typeof vi.fn>;
}

function makeKv(seed: Record<string, string> = {}): KvMock {
  const store = new Map<string, string>(Object.entries(seed));
  const puts: PutCall[] = [];
  const list = vi.fn(async () => ({
    keys: [...store.keys()].map((name) => ({ name })),
    list_complete: true,
    cacheStatus: null,
  }));
  const kv = {
    get: async (k: string, type?: 'json') => {
      const raw = store.get(k);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (k: string, v: string, options?: KVNamespacePutOptions) => {
      puts.push({ key: k, value: v, options });
      store.set(k, v);
    },
    list,
  } as unknown as KVNamespace;
  return { kv, store, puts, list };
}

// heartbeat.ts は game.idle_check.timeout_min しか見ないので、他は型を満たすためだけのダミー。
function makeGame(gameId: string): GameDefinition {
  return {
    game_id: gameId,
    display_name: gameId,
    idle_check: {
      type: 'minecraft_rcon',
      timeout_min: 10,
      heartbeat_interval_sec: 60,
      config: {},
    },
  } as unknown as GameDefinition;
}

const INSTANCE_ID = 'i-abc';
const TIMESTAMP = 1_700_000_000;
const BODY = JSON.stringify({
  game_id: 'atm11',
  instance_id: INSTANCE_ID,
  timestamp: TIMESTAMP,
  player_count: 0,
});
const LAST_SEEN_TTL_SEC = 10 * 60 * 3;

function makeEnv(opts: {
  games?: Record<string, GameDefinition>;
  index?: unknown;
}): { env: Env; gamesKv: KvMock; stateKv: KvMock } {
  const gameSeed: Record<string, string> = {};
  for (const [id, game] of Object.entries(opts.games ?? {})) {
    gameSeed[id] = JSON.stringify(game);
  }
  // index 未指定のときはキー自体を作らない (KV の miss を再現)。
  const stateSeed: Record<string, string> = {};
  if (opts.index !== undefined) {
    stateSeed[REGISTRY_INDEX_KEY] = JSON.stringify(opts.index);
  }
  const games = makeKv(gameSeed);
  const state = makeKv(stateSeed);
  return {
    env: { GAME_REGISTRY: games.kv, SERVER_STATE: state.kv } as unknown as Env,
    gamesKv: games,
    stateKv: state,
  };
}

// auth.js は mock 済みなので request の中身は検証されない (何も読まれない)。
function makeRequest(): Request {
  return new Request('https://worker.example/sidecar/heartbeat', { method: 'POST' });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.mocked(verifySidecarPostRequest).mockReset().mockResolvedValue({
    ok: true,
    gameId: 'atm11',
    body: BODY,
    timestamp: TIMESTAMP,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleSidecarHeartbeat — registry-index 自己修復', () => {
  it('index に自分の id が無ければ last-seen を書いたうえで index に足す', async () => {
    const { env, stateKv } = makeEnv({
      games: { atm10: makeGame('atm10'), atm11: makeGame('atm11') },
      index: ['atm10'],
    });

    const res = await handleSidecarHeartbeat(makeRequest(), env);

    expect(res.status).toBe(204);
    expect(stateKv.puts).toContainEqual({
      key: 'last-seen:atm11',
      value: expect.any(String),
      options: { expirationTtl: LAST_SEEN_TTL_SEC },
    });
    expect(JSON.parse(stateKv.store.get('last-seen:atm11')!)).toMatchObject({
      gameId: 'atm11',
      instanceId: INSTANCE_ID,
    });
    expect(JSON.parse(stateKv.store.get(REGISTRY_INDEX_KEY)!)).toEqual([
      'atm10',
      'atm11',
    ]);
  });

  it('index に自分の id が既にあれば index への put も list もしない', async () => {
    const { env, gamesKv, stateKv } = makeEnv({
      games: { atm10: makeGame('atm10'), atm11: makeGame('atm11') },
      index: ['atm10', 'atm11'],
    });

    const res = await handleSidecarHeartbeat(makeRequest(), env);

    expect(res.status).toBe(204);
    expect(stateKv.puts.filter((p) => p.key === REGISTRY_INDEX_KEY)).toEqual([]);
    expect(gamesKv.list).not.toHaveBeenCalled();
  });

  it('index が無ければ index を作らない (次の listGames に任せる)', async () => {
    const { env, gamesKv, stateKv } = makeEnv({ games: { atm11: makeGame('atm11') } });

    const res = await handleSidecarHeartbeat(makeRequest(), env);

    expect(res.status).toBe(204);
    expect(stateKv.puts.filter((p) => p.key === REGISTRY_INDEX_KEY)).toEqual([]);
    expect(gamesKv.list).not.toHaveBeenCalled();
  });

  it('SERVER_STATE.get (index) が throw しても 204 を返し、last-seen は書かれている', async () => {
    const { env, stateKv } = makeEnv({
      games: { atm10: makeGame('atm10'), atm11: makeGame('atm11') },
      index: ['atm10'],
    });
    // この経路で SERVER_STATE.get を呼ぶのは ensureGameIndexed の index get だけ。
    vi.spyOn(stateKv.kv, 'get').mockRejectedValue(new Error('KV unavailable'));

    const res = await handleSidecarHeartbeat(makeRequest(), env);

    expect(res.status).toBe(204);
    expect(stateKv.store.has('last-seen:atm11')).toBe(true);
    expect(vi.mocked(console.warn)).toHaveBeenCalled();
  });
});
