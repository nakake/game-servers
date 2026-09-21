// lib/registry/store.ts のテスト。
//
// GAME_REGISTRY / SERVER_STATE を in-memory Map の KV モックにして、index が効いているときは
// list を消費しないこと、index が無い / 壊れているときは list から作り直して TTL 付きで put
// することを確認する。list の呼び出し回数を数えるため、モックの list は vi.fn にする。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REGISTRY_INDEX_KEY,
  REGISTRY_INDEX_TTL_SECONDS,
} from './registry-index.js';
import { ensureGameIndexed, listGames, rebuildRegistryIndex } from './store.js';
import type { GameDefinition } from './types.js';
import type { Env } from '../../env.js';

// put の第 3 引数 (expirationTtl) まで記録する KV モック。
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

// store.ts は JSON をそのまま返すだけなので、game_id 以外は型を満たすためだけのダミー。
function makeGame(gameId: string): GameDefinition {
  return { game_id: gameId, display_name: gameId } as unknown as GameDefinition;
}

function makeEnv(opts: {
  games?: Record<string, GameDefinition>;
  index?: unknown;
}): {
  env: Pick<Env, 'GAME_REGISTRY' | 'SERVER_STATE'>;
  gamesKv: KvMock;
  stateKv: KvMock;
} {
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
    env: { GAME_REGISTRY: games.kv, SERVER_STATE: state.kv },
    gamesKv: games,
    stateKv: state,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listGames — index hit', () => {
  it('index の id を get するだけで list を呼ばない (index の順で返る)', async () => {
    const { env, gamesKv, stateKv } = makeEnv({
      games: { atm10: makeGame('atm10'), atm11: makeGame('atm11') },
      index: ['atm11', 'atm10'],
    });

    const games = await listGames(env);

    expect(games.map((g) => g.game_id)).toEqual(['atm11', 'atm10']);
    expect(gamesKv.list).not.toHaveBeenCalled();
    expect(stateKv.puts).toEqual([]);
  });
});

describe('listGames — index miss', () => {
  it('list を 1 回呼び、昇順の id 配列を TTL 3600 で put する', async () => {
    const { env, gamesKv, stateKv } = makeEnv({
      games: { atm10: makeGame('atm10'), atm11: makeGame('atm11') },
    });

    const games = await listGames(env);

    expect(games.map((g) => g.game_id)).toEqual(['atm10', 'atm11']);
    expect(gamesKv.list).toHaveBeenCalledTimes(1);
    expect(stateKv.puts).toEqual([
      {
        key: REGISTRY_INDEX_KEY,
        value: JSON.stringify(['atm10', 'atm11']),
        options: { expirationTtl: REGISTRY_INDEX_TTL_SECONDS },
      },
    ]);
  });

  const brokenIndexes: [string, unknown][] = [
    ['オブジェクト', { keys: ['atm10'] }],
    ['空配列', []],
    ['非文字列要素の混入', ['atm10', 1]],
  ];

  it.each(brokenIndexes)('壊れた index (%s) は miss 扱いで list から返す', async (_label, index) => {
    const { env, gamesKv } = makeEnv({
      games: { atm10: makeGame('atm10') },
      index,
    });

    const games = await listGames(env);

    expect(games.map((g) => g.game_id)).toEqual(['atm10']);
    expect(gamesKv.list).toHaveBeenCalledTimes(1);
  });

  it('SERVER_STATE.get が throw しても list 経由で結果が返る', async () => {
    const { env, gamesKv, stateKv } = makeEnv({
      games: { atm10: makeGame('atm10') },
    });
    vi.spyOn(stateKv.kv, 'get').mockRejectedValue(new Error('KV unavailable'));

    const games = await listGames(env);

    expect(games.map((g) => g.game_id)).toEqual(['atm10']);
    expect(gamesKv.list).toHaveBeenCalledTimes(1);
  });

  it('SERVER_STATE.put が throw しても結果は返る (例外が漏れない)', async () => {
    const { env, stateKv } = makeEnv({
      games: { atm10: makeGame('atm10') },
    });
    vi.spyOn(stateKv.kv, 'put').mockRejectedValue(new Error('429'));

    const games = await listGames(env);

    expect(games.map((g) => g.game_id)).toEqual(['atm10']);
    expect(vi.mocked(console.warn)).toHaveBeenCalled();
  });

  it('GAME_REGISTRY が 0 件なら [] を返し、put は呼ばれない', async () => {
    const { env, stateKv } = makeEnv({});

    await expect(listGames(env)).resolves.toEqual([]);
    expect(stateKv.puts).toEqual([]);
  });

  it('index に削除済み id が残っていても結果から除かれる', async () => {
    const { env, gamesKv } = makeEnv({
      games: { atm10: makeGame('atm10') },
      index: ['atm10', 'gone'],
    });

    const games = await listGames(env);

    expect(games.map((g) => g.game_id)).toEqual(['atm10']);
    // index は hit しているので list は呼ばれない。
    expect(gamesKv.list).not.toHaveBeenCalled();
  });
});

describe('rebuildRegistryIndex', () => {
  it('list に無い extraIds も返り値と put された index の両方に入る', async () => {
    const { env, stateKv } = makeEnv({
      games: { atm10: makeGame('atm10'), atm11: makeGame('atm11') },
    });

    const ids = await rebuildRegistryIndex(env, ['zzz']);

    expect(ids).toEqual(['atm10', 'atm11', 'zzz']);
    expect(JSON.parse(stateKv.store.get(REGISTRY_INDEX_KEY)!)).toEqual([
      'atm10',
      'atm11',
      'zzz',
    ]);
  });

  it('list に既にある id を extraIds に渡しても重複しない', async () => {
    const { env } = makeEnv({ games: { atm10: makeGame('atm10') } });

    await expect(rebuildRegistryIndex(env, ['atm10', 'zzz'])).resolves.toEqual([
      'atm10',
      'zzz',
    ]);
  });
});

describe('ensureGameIndexed', () => {
  it('index に gameId が無ければ元の id を残したまま gameId を足して TTL 3600 で put する', async () => {
    const { env, gamesKv, stateKv } = makeEnv({
      games: { atm10: makeGame('atm10'), atm11: makeGame('atm11') },
      index: ['atm10'],
    });

    await ensureGameIndexed(env, 'atm11');

    expect(gamesKv.list).toHaveBeenCalledTimes(1);
    expect(stateKv.puts).toEqual([
      {
        key: REGISTRY_INDEX_KEY,
        value: JSON.stringify(['atm10', 'atm11']),
        options: { expirationTtl: REGISTRY_INDEX_TTL_SECONDS },
      },
    ]);
    expect(JSON.parse(stateKv.store.get(REGISTRY_INDEX_KEY)!)).toEqual([
      'atm10',
      'atm11',
    ]);
  });

  it('index に gameId が既にあれば put も list もしない', async () => {
    const { env, gamesKv, stateKv } = makeEnv({
      games: { atm10: makeGame('atm10'), atm11: makeGame('atm11') },
      index: ['atm10', 'atm11'],
    });

    await ensureGameIndexed(env, 'atm11');

    expect(stateKv.puts).toEqual([]);
    expect(gamesKv.list).not.toHaveBeenCalled();
  });

  it('index が無ければ put も list もしない (次の listGames が作り直す)', async () => {
    const { env, gamesKv, stateKv } = makeEnv({ games: { atm11: makeGame('atm11') } });

    await ensureGameIndexed(env, 'atm11');

    expect(stateKv.puts).toEqual([]);
    expect(gamesKv.list).not.toHaveBeenCalled();
  });

  it('SERVER_STATE.get が throw しても例外が漏れない', async () => {
    const { env, stateKv } = makeEnv({ games: { atm11: makeGame('atm11') } });
    vi.spyOn(stateKv.kv, 'get').mockRejectedValue(new Error('KV unavailable'));

    await expect(ensureGameIndexed(env, 'atm11')).resolves.toBeUndefined();

    expect(vi.mocked(console.warn)).toHaveBeenCalled();
    expect(stateKv.puts).toEqual([]);
  });

  it('GAME_REGISTRY.list が throw しても例外が漏れない (index に gameId が無い状態)', async () => {
    const { env, gamesKv, stateKv } = makeEnv({
      games: { atm10: makeGame('atm10'), atm11: makeGame('atm11') },
      index: ['atm10'],
    });
    gamesKv.list.mockRejectedValue(new Error('KV unavailable'));

    await expect(ensureGameIndexed(env, 'atm11')).resolves.toBeUndefined();

    expect(vi.mocked(console.warn)).toHaveBeenCalled();
    expect(stateKv.puts).toEqual([]);
  });
});
