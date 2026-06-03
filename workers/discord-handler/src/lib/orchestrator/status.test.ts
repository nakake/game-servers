import { describe, expect, it } from 'vitest';

import { toServerState } from './status.js';

// E-1 で唯一の新規ロジック: EC2 instance-state-name → @gs/shared の ServerState 契約への畳み込み。
// AWS を叩く getGameStatus 本体は統合経路 (node vitest では検証不能) なので、この純粋関数だけ固定する。
describe('toServerState', () => {
  it('maps live states straight through', () => {
    expect(toServerState('running')).toBe('running');
    expect(toServerState('pending')).toBe('pending');
  });

  it('folds transitional teardown states to stopping', () => {
    expect(toServerState('stopping')).toBe('stopping');
    expect(toServerState('shutting-down')).toBe('stopping');
  });

  it('folds stopped and terminated to stopped', () => {
    expect(toServerState('stopped')).toBe('stopped');
    expect(toServerState('terminated')).toBe('stopped');
  });
});
