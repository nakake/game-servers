// handlers/cleanup.ts のテスト。
//
// pending-cleanup と getAwsCredentials を差し替え、認証失敗時の分岐を assert する:
//   - pending 0 件 → credentials を取りに行かず return (既存の順序を維持)
//   - isTransient な OidcCredentialError → 通知せず resolve (次 tick に再試行)
//   - それ以外 → Cron が outcome=exception になるよう rethrow

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/aws/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/aws/index.js')>();
  return { ...actual, getAwsCredentials: vi.fn(), describeSnapshotById: vi.fn() };
});
vi.mock('../lib/state/pending-cleanup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/state/pending-cleanup.js')>();
  return { ...actual, listPendingCleanups: vi.fn(), deletePendingCleanup: vi.fn() };
});
vi.mock('../lib/discord/webhook.js', () => ({
  postDiscordWebhookMessage: vi.fn(async () => true),
}));
vi.mock('../lib/state/notif-suppress.js', () => ({
  shouldNotify: vi.fn(async () => true),
}));

import {
  describeSnapshotById,
  getAwsCredentials,
  OidcCredentialError,
} from '../lib/aws/index.js';
import { postDiscordWebhookMessage } from '../lib/discord/webhook.js';
import { shouldNotify } from '../lib/state/notif-suppress.js';
import { listPendingCleanups, type PendingCleanup } from '../lib/state/pending-cleanup.js';

import { handleVolumeCleanup } from './cleanup.js';
import type { Env } from '../env.js';

const ENTRY: PendingCleanup = {
  gameId: 'atm11',
  volumeId: 'vol-0123456789abcdef0',
  snapshotId: 'snap-0123456789abcdef0',
  requestedAt: '2026-09-21T02:00:00.000Z',
};

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
  vi.mocked(describeSnapshotById).mockReset();
  vi.mocked(listPendingCleanups).mockReset().mockResolvedValue([]);
  vi.mocked(postDiscordWebhookMessage).mockReset().mockResolvedValue(true);
  // 「通知しない」ことを確かめるテストなので、suppress されない (true) 状態にしておく。
  // false に固定すると、handler が通知を呼んでも webhook が呼ばれず assertion が空振りする。
  vi.mocked(shouldNotify).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleVolumeCleanup — credential failure', () => {
  it('pending 0 件なら getAwsCredentials を呼ばずに return する', async () => {
    vi.mocked(listPendingCleanups).mockResolvedValue([]);

    await expect(handleVolumeCleanup(makeEnv(), makeCtx())).resolves.toBeUndefined();

    expect(getAwsCredentials).not.toHaveBeenCalled();
  });

  it('transient (Http525) は通知せず resolve し、AWS に触らない', async () => {
    vi.mocked(listPendingCleanups).mockResolvedValue([ENTRY]);
    vi.mocked(getAwsCredentials).mockRejectedValue(new OidcCredentialError('Http525', 525));

    await expect(handleVolumeCleanup(makeEnv(), makeCtx())).resolves.toBeUndefined();

    expect(describeSnapshotById).not.toHaveBeenCalled();
    expect(postDiscordWebhookMessage).not.toHaveBeenCalled();
    // 二重通知はしないが、エラーコードは wrangler tail 用に残す。
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('Http525');
  });

  it('non-transient (AccessDenied 403) はそのまま reject する', async () => {
    vi.mocked(listPendingCleanups).mockResolvedValue([ENTRY]);
    const err = new OidcCredentialError('AccessDenied', 403);
    vi.mocked(getAwsCredentials).mockRejectedValue(err);

    await expect(handleVolumeCleanup(makeEnv(), makeCtx())).rejects.toBe(err);
    expect(describeSnapshotById).not.toHaveBeenCalled();
  });
});
