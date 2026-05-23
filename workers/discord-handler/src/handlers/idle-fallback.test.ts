import { describe, expect, it } from 'vitest';

import type { GameDefinition } from '../lib/registry/types.js';
import type { SidecarLastSeen } from '../lib/state/last-seen.js';
import { decideIdleAction } from './idle-fallback.js';

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
