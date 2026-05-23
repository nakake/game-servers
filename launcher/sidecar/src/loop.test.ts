import { describe, expect, it } from 'vitest';

import { evaluateTick, type LoopState } from './loop.js';

const TIMEOUT_MS = 10 * 60_000;
const COOLDOWN_MS = 5 * 60_000;
const NOW = 100_000_000;

function freshState(lastNonIdleAgoMs: number): LoopState {
  return { lastNonIdleMs: NOW - lastNonIdleAgoMs, lastNotifiedMs: 0 };
}

describe('evaluateTick', () => {
  it('refreshes lastNonIdleMs and reports -1 on adapter failure', () => {
    const state = freshState(60_000);
    const decision = evaluateTick(state, {
      result: null,
      now: NOW,
      idleTimeoutMs: TIMEOUT_MS,
      postNotifyCooldownMs: COOLDOWN_MS,
    });
    expect(decision).toEqual({ heartbeatPlayerCount: -1, shouldNotifyIdle: false });
    expect(state.lastNonIdleMs).toBe(NOW);
  });

  it('updates lastNonIdleMs when adapter reports non-idle', () => {
    const state = freshState(5 * 60_000);
    const decision = evaluateTick(state, {
      result: { playerCount: 3, idle: false },
      now: NOW,
      idleTimeoutMs: TIMEOUT_MS,
      postNotifyCooldownMs: COOLDOWN_MS,
    });
    expect(decision).toEqual({ heartbeatPlayerCount: 3, shouldNotifyIdle: false });
    expect(state.lastNonIdleMs).toBe(NOW);
  });

  it('stays quiet while idle but below timeout', () => {
    const state = freshState(5 * 60_000); // 5 min ago (< 10 min)
    const decision = evaluateTick(state, {
      result: { playerCount: 0, idle: true },
      now: NOW,
      idleTimeoutMs: TIMEOUT_MS,
      postNotifyCooldownMs: COOLDOWN_MS,
    });
    expect(decision).toEqual({ heartbeatPlayerCount: 0, shouldNotifyIdle: false });
  });

  it('notifies once when idle exceeds timeout and never notified before', () => {
    const state = freshState(15 * 60_000); // 15 min ago (> 10 min)
    const decision = evaluateTick(state, {
      result: { playerCount: 0, idle: true },
      now: NOW,
      idleTimeoutMs: TIMEOUT_MS,
      postNotifyCooldownMs: COOLDOWN_MS,
    });
    expect(decision).toEqual({ heartbeatPlayerCount: 0, shouldNotifyIdle: true });
  });

  it('suppresses re-notification within cooldown', () => {
    const state: LoopState = {
      lastNonIdleMs: NOW - 20 * 60_000,
      lastNotifiedMs: NOW - 2 * 60_000, // 2 min ago (< 5 min cooldown)
    };
    const decision = evaluateTick(state, {
      result: { playerCount: 0, idle: true },
      now: NOW,
      idleTimeoutMs: TIMEOUT_MS,
      postNotifyCooldownMs: COOLDOWN_MS,
    });
    expect(decision.shouldNotifyIdle).toBe(false);
  });

  it('re-notifies once cooldown has elapsed', () => {
    const state: LoopState = {
      lastNonIdleMs: NOW - 20 * 60_000,
      lastNotifiedMs: NOW - 6 * 60_000, // 6 min ago (> 5 min cooldown)
    };
    const decision = evaluateTick(state, {
      result: { playerCount: 0, idle: true },
      now: NOW,
      idleTimeoutMs: TIMEOUT_MS,
      postNotifyCooldownMs: COOLDOWN_MS,
    });
    expect(decision.shouldNotifyIdle).toBe(true);
  });
});
