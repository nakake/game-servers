// handlers/discord/start.ts のテスト。
//
// executeStart は export されていないので、handleStartCommand が ctx.waitUntil に渡した Promise を
// 待つ形で検証する (テストのために export を増やさない)。
// 認証失敗 (OidcCredentialError) が既存の catch に入り、deferred メッセージが ❌ 文言に
// 更新されることを確認する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// follow-up の editOriginal 呼び出しを記録する。mock は hoist されるため vi.hoisted で共有する。
const followUpMock = vi.hoisted(() => ({
  editOriginal: vi.fn(async (_content: string) => undefined),
}));

vi.mock('../../lib/discord/follow-up.js', () => ({
  DiscordFollowUpClient: class {
    editOriginal = followUpMock.editOriginal;
  },
}));
vi.mock('../../lib/aws/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/aws/index.js')>();
  return { ...actual, getAwsCredentials: vi.fn() };
});
vi.mock('../../lib/registry/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/registry/store.js')>();
  return { ...actual, getGame: vi.fn() };
});

import { getAwsCredentials, OidcCredentialError } from '../../lib/aws/index.js';
import { getGame } from '../../lib/registry/store.js';

import { handleStartCommand } from './start.js';
import type { Interaction } from '../../lib/discord/types.js';
import type { GameDefinition } from '../../lib/registry/types.js';
import type { Env } from '../../env.js';

// getAwsCredentials で落ちるため enabled / discord.start_message 以外は使われない。
const GAME = {
  game_id: 'atm11',
  enabled: true,
  discord: { start_message: '起動処理を開始します' },
} as unknown as GameDefinition;

function startInteraction(): Interaction {
  return {
    id: 'i1',
    application_id: 'app1',
    token: 'itok',
    type: 2,
    data: {
      id: 'c1',
      name: 'start',
      type: 1,
      options: [{ name: 'game', type: 3, value: 'atm11' }],
    },
  };
}

function makeEnv(): Env {
  return { DISCORD_APPLICATION_ID: 'app1' } as unknown as Env;
}

function makeCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    settled: async () => {
      await Promise.allSettled(pending);
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  followUpMock.editOriginal.mockReset().mockResolvedValue(undefined);
  vi.mocked(getAwsCredentials).mockReset();
  vi.mocked(getGame).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleStartCommand — credential failure', () => {
  it('getAwsCredentials が OidcCredentialError を投げると follow-up を ❌ 文言で 1 回編集する', async () => {
    vi.mocked(getGame).mockResolvedValue(GAME);
    vi.mocked(getAwsCredentials).mockRejectedValue(new OidcCredentialError('Http525', 525));
    const { ctx, settled } = makeCtx();

    await handleStartCommand(startInteraction(), makeEnv(), ctx);
    await settled();

    expect(followUpMock.editOriginal).toHaveBeenCalledTimes(1);
    const content = followUpMock.editOriginal.mock.calls[0]?.[0];
    expect(content?.startsWith('❌')).toBe(true);
  });
});
