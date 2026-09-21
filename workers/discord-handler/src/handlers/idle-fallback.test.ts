import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sidecar/auth.js', () => ({ verifySidecarPostRequest: vi.fn() }));
vi.mock('./stop-workflow.js', () => ({ runStopWorkflow: vi.fn() }));

import { REGISTRY_INDEX_KEY } from '../lib/registry/registry-index.js';
import type { GameDefinition } from '../lib/registry/types.js';
import type { SidecarLastSeen } from '../lib/state/last-seen.js';
import { decideIdleAction, handleIdleFallback } from './idle-fallback.js';
import { verifySidecarPostRequest } from './sidecar/auth.js';
import { handleSidecarHeartbeat } from './sidecar/heartbeat.js';
import { runStopWorkflow, type RunStopWorkflowOptions } from './stop-workflow.js';
import type { Env } from '../env.js';

// テスト用の最小 GameDefinition。idle_check.timeout_min と game_id 以外は使われない。
function makeGame(overrides: Partial<GameDefinition['idle_check']> = {}): GameDefinition {
  return {
    game_id: 'atm11',
    idle_check: {
      type: 'minecraft_rcon',
      timeout_min: 10,
      heartbeat_interval_sec: 60,
      config: {},
      ...overrides,
    },
    // 残りは decideIdleAction の対象外。型を満たすためダミーで埋める。
  } as unknown as GameDefinition;
}

function makeLastSeen(overrides: Partial<SidecarLastSeen> = {}): SidecarLastSeen {
  return {
    gameId: 'atm11',
    instanceId: 'i-abc',
    lastSeenAt: '2026-05-23T12:00:00.000Z',
    playerCount: 0,
    ...overrides,
  };
}

const NOW = Date.parse('2026-05-23T12:30:00.000Z'); // 12:00 から 30 分後

// ---- handleIdleFallback 用のヘルパー ----

// GAME_REGISTRY / SERVER_STATE の in-memory Map モック (store.test.ts と同じ作り)。
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

// GAME_REGISTRY に入れるゲーム。handleIdleFallback は enabled と idle_check.timeout_min を見る。
function makeRegistryGame(gameId: string): GameDefinition {
  return {
    ...makeGame(),
    game_id: gameId,
    enabled: true,
  } as unknown as GameDefinition;
}

function makeEnv(opts: {
  games?: Record<string, GameDefinition>;
  index?: unknown;
  lastSeen?: SidecarLastSeen[];
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
  for (const lastSeen of opts.lastSeen ?? []) {
    stateSeed[`last-seen:${lastSeen.gameId}`] = JSON.stringify(lastSeen);
  }
  const games = makeKv(gameSeed);
  const state = makeKv(stateSeed);
  return {
    env: { GAME_REGISTRY: games.kv, SERVER_STATE: state.kv } as unknown as Env,
    gamesKv: games,
    stateKv: state,
  };
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

// runStopWorkflow の呼び出し引数 (env, ctx, game, opts) を取り出す。
function stopCall(): [Env, ExecutionContext, GameDefinition, RunStopWorkflowOptions] {
  return vi.mocked(runStopWorkflow).mock.calls[0] as [
    Env,
    ExecutionContext,
    GameDefinition,
    RunStopWorkflowOptions,
  ];
}

describe('decideIdleAction', () => {
  it('skips with reason "no-heartbeat" when last_seen is missing', () => {
    const game = makeGame();
    const decision = decideIdleAction(game, undefined, NOW);
    expect(decision).toEqual({ action: 'skip', reason: 'no-heartbeat' });
  });

  it('skips with reason "within-window" when silence < timeout_min + 5 min', () => {
    // 12:30 から 12 分前 (= 12:18) の heartbeat。timeout_min=10 + skew=5 → 15 分閾値。OK。
    const game = makeGame({ timeout_min: 10 });
    const lastSeen = makeLastSeen({ lastSeenAt: '2026-05-23T12:18:00.000Z' });
    const decision = decideIdleAction(game, lastSeen, NOW);
    expect(decision).toEqual({ action: 'skip', reason: 'within-window' });
  });

  it('triggers stop when silence > timeout_min + 5 min', () => {
    // 12:30 から 20 分前 (= 12:10) の heartbeat。15 分閾値を超えている → 強制停止。
    const game = makeGame({ timeout_min: 10 });
    const lastSeen = makeLastSeen({
      lastSeenAt: '2026-05-23T12:10:00.000Z',
      instanceId: 'i-stale',
    });
    const decision = decideIdleAction(game, lastSeen, NOW);
    expect(decision.action).toBe('stop');
    if (decision.action === 'stop') {
      expect(decision.expectedInstanceId).toBe('i-stale');
      expect(decision.elapsedMs).toBe(20 * 60_000);
      expect(decision.thresholdMs).toBe(15 * 60_000);
    }
  });

  it('treats elapsed == threshold as still within window (skips)', () => {
    // 閾値ぴったり (15 分) は許容 (`<= threshold` の境界判定)。境界で誤発火しないことを担保。
    const game = makeGame({ timeout_min: 10 });
    const lastSeen = makeLastSeen({ lastSeenAt: '2026-05-23T12:15:00.000Z' });
    const decision = decideIdleAction(game, lastSeen, NOW);
    expect(decision).toEqual({ action: 'skip', reason: 'within-window' });
  });

  it('skips with reason "invalid-data" when lastSeenAt cannot be parsed', () => {
    const game = makeGame();
    const lastSeen = makeLastSeen({ lastSeenAt: 'not a date' });
    const decision = decideIdleAction(game, lastSeen, NOW);
    expect(decision).toEqual({ action: 'skip', reason: 'invalid-data' });
  });
});

describe('handleIdleFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(runStopWorkflow).mockReset().mockResolvedValue({
      status: 'already-stopped',
      reason: 'no-instance',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('index にあるゲームが閾値を超えて沈黙したら runStopWorkflow を呼ぶ (list は呼ばない)', async () => {
    const { env, gamesKv } = makeEnv({
      games: { atm11: makeRegistryGame('atm11') },
      index: ['atm11'],
      lastSeen: [
        makeLastSeen({
          lastSeenAt: '2026-05-23T12:14:00.000Z', // NOW の 16 分前 (閾値は 15 分)
          instanceId: 'i-stale',
        }),
      ],
    });

    const outcomes = await handleIdleFallback(env, makeCtx());

    expect(gamesKv.list).not.toHaveBeenCalled();
    expect(runStopWorkflow).toHaveBeenCalledTimes(1);
    expect(stopCall()[2]).toEqual(makeRegistryGame('atm11'));
    expect(stopCall()[3]).toEqual({
      triggeredBy: 'cron-fallback',
      expectedInstanceId: 'i-stale',
    });
    expect(outcomes.map((o) => o.decision.action)).toEqual(['stop']);
  });

  it('index が無くても list から作り直して runStopWorkflow を呼ぶ', async () => {
    const { env, gamesKv } = makeEnv({
      games: { atm11: makeRegistryGame('atm11') },
      lastSeen: [makeLastSeen({ lastSeenAt: '2026-05-23T12:14:00.000Z' })],
    });

    await handleIdleFallback(env, makeCtx());

    expect(gamesKv.list).toHaveBeenCalledTimes(1);
    expect(runStopWorkflow).toHaveBeenCalledTimes(1);
    expect(stopCall()[2].game_id).toBe('atm11');
  });

  it('index に無いゲームでも heartbeat が index を直し、沈黙後に停止できる', async () => {
    const { env, stateKv } = makeEnv({
      games: { atm10: makeRegistryGame('atm10'), atm11: makeRegistryGame('atm11') },
      index: ['atm10'], // atm11 を含まない古い index
    });
    vi.mocked(verifySidecarPostRequest).mockResolvedValue({
      ok: true,
      gameId: 'atm11',
      body: JSON.stringify({
        game_id: 'atm11',
        instance_id: 'i-abc',
        timestamp: 1_700_000_000,
        player_count: 0,
      }),
      timestamp: 1_700_000_000,
    });

    const res = await handleSidecarHeartbeat(
      new Request('https://worker.example/sidecar/heartbeat', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(204);

    vi.advanceTimersByTime(16 * 60_000); // heartbeat から 16 分沈黙 (閾値は 15 分)

    await handleIdleFallback(env, makeCtx());

    expect(runStopWorkflow).toHaveBeenCalledTimes(1);
    expect(stopCall()[2].game_id).toBe('atm11');
    expect(stopCall()[3]).toEqual({
      triggeredBy: 'cron-fallback',
      expectedInstanceId: 'i-abc',
    });
    expect(JSON.parse(stateKv.store.get(REGISTRY_INDEX_KEY)!)).toEqual([
      'atm10',
      'atm11',
    ]);
  });

  it('閾値以内 (5 分) の沈黙では runStopWorkflow を呼ばない', async () => {
    const { env } = makeEnv({
      games: { atm11: makeRegistryGame('atm11') },
      index: ['atm11'],
      lastSeen: [makeLastSeen({ lastSeenAt: '2026-05-23T12:25:00.000Z' })],
    });

    const outcomes = await handleIdleFallback(env, makeCtx());

    expect(runStopWorkflow).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      { gameId: 'atm11', decision: { action: 'skip', reason: 'within-window' } },
    ]);
  });
});
