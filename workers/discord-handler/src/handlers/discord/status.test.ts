// handlers/discord/status.ts のテスト。
//
// executeStatus は export されていないので、handleStatusCommand が ctx.waitUntil に渡した Promise を
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

import { getAwsCredentials, OidcCredentialError } from '../../lib/aws/index.js';

import { handleStatusCommand } from './status.js';
import type { Interaction } from '../../lib/discord/types.js';
import type { Env } from '../../env.js';

function statusInteraction(): Interaction {
  return {
    id: 'i1',
    application_id: 'app1',
    token: 'itok',
    type: 2,
    data: { id: 'c1', name: 'status', type: 1 },
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleStatusCommand — credential failure', () => {
  it('getAwsCredentials が OidcCredentialError を投げると follow-up を ❌ 文言で 1 回編集する', async () => {
    vi.mocked(getAwsCredentials).mockRejectedValue(new OidcCredentialError('AccessDenied', 403));
    const { ctx, settled } = makeCtx();

    await handleStatusCommand(statusInteraction(), makeEnv(), ctx);
    await settled();

    expect(followUpMock.editOriginal).toHaveBeenCalledTimes(1);
    const content = followUpMock.editOriginal.mock.calls[0]?.[0];
    expect(content?.startsWith('❌')).toBe(true);
  });
});
