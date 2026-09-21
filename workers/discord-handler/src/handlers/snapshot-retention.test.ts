// handlers/snapshot-retention.ts のテスト。
//
// getAwsCredentials だけを差し替え、認証失敗時の分岐を直接 assert する:
//   - isTransient な OidcCredentialError (525 等) → 通知せず resolve (次 tick に再試行)
//   - それ以外 (403 等) → Cron が outcome=exception になるよう rethrow
// AWS / registry / Discord に触れないことも合わせて確認する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/aws/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/aws/index.js')>();
  return { ...actual, getAwsCredentials: vi.fn() };
});
vi.mock('../lib/registry/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/registry/store.js')>();
  return { ...actual, listGames: vi.fn() };
});
vi.mock('../lib/discord/webhook.js', () => ({
  postDiscordWebhookMessage: vi.fn(async () => true),
}));
vi.mock('../lib/state/notif-suppress.js', () => ({
  shouldNotify: vi.fn(async () => true),
}));

import { getAwsCredentials, OidcCredentialError } from '../lib/aws/index.js';
import { postDiscordWebhookMessage } from '../lib/discord/webhook.js';
import { listGames } from '../lib/registry/store.js';
import { shouldNotify } from '../lib/state/notif-suppress.js';

import { handleSnapshotRetention } from './snapshot-retention.js';
import type { Env } from '../env.js';

function makeEnv(): Env {
  return { SERVER_STATE: {} as KVNamespace } as unknown as Env;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(getAwsCredentials).mockReset();
  vi.mocked(listGames).mockReset().mockResolvedValue([]);
  vi.mocked(postDiscordWebhookMessage).mockReset().mockResolvedValue(true);
  // 「通知しない」ことを確かめるテストなので、suppress されない (true) 状態にしておく。
  // false に固定すると、handler が通知を呼んでも webhook が呼ばれず assertion が空振りする。
  vi.mocked(shouldNotify).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleSnapshotRetention — credential failure', () => {
  it('transient (Http525) は通知せず resolve し、AWS / registry に触らない', async () => {
    vi.mocked(getAwsCredentials).mockRejectedValue(new OidcCredentialError('Http525', 525));

    await expect(handleSnapshotRetention(makeEnv(), makeCtx())).resolves.toBeUndefined();

    expect(listGames).not.toHaveBeenCalled();
    expect(postDiscordWebhookMessage).not.toHaveBeenCalled();
    // 二重通知はしないが、エラーコードは wrangler tail 用に残す。
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('Http525');
  });

  it('non-transient (AccessDenied 403) はそのまま reject する', async () => {
    const err = new OidcCredentialError('AccessDenied', 403);
    vi.mocked(getAwsCredentials).mockRejectedValue(err);

    await expect(handleSnapshotRetention(makeEnv(), makeCtx())).rejects.toBe(err);
    expect(listGames).not.toHaveBeenCalled();
  });
});
