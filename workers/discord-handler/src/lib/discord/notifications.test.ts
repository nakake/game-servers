import { describe, expect, it } from 'vitest';

import {
  buildCronFailureNotification,
  buildIdleStopNotification,
} from './notifications.js';
import type {
  StopWorkflowOutcome,
} from '../../handlers/stop-workflow.js';
import type { GameDefinition } from '../registry/types.js';

// テストでは display_name と game_id だけ参照される。他フィールドは最低限を埋める。
const GAME = {
  game_id: 'atm11',
  display_name: 'All The Mods 11',
} as unknown as GameDefinition;

const OK_OUTCOME: StopWorkflowOutcome = {
  status: 'ok',
  instanceId: 'i-deadbeef',
  snapshotId: 'snap-12345',
  volumeId: 'vol-abcdef',
  pendingCleanupScheduled: true,
  dnsReset: true,
  dockerStopSucceeded: true,
};

describe('buildIdleStopNotification', () => {
  it('returns undefined when triggeredBy is discord (Discord 経路は follow-up edit 重複防止)', () => {
    expect(buildIdleStopNotification(GAME, OK_OUTCOME, 'discord')).toBeUndefined();
  });

  it('returns undefined for already-stopped outcome (通知価値が低いノイズ抑制)', () => {
    const outcome: StopWorkflowOutcome = { status: 'already-stopped', reason: 'no-instance' };
    expect(buildIdleStopNotification(GAME, outcome, 'sidecar')).toBeUndefined();
    expect(buildIdleStopNotification(GAME, outcome, 'cron-fallback')).toBeUndefined();
  });

  describe('status: ok', () => {
    it('builds an info embed (📴, blue) when sidecar triggered (happy path)', () => {
      const embed = buildIdleStopNotification(GAME, OK_OUTCOME, 'sidecar');
      expect(embed).toBeDefined();
      expect(embed?.title).toBe('📴 All The Mods 11 を自動停止しました');
      expect(embed?.color).toBe(0x3498db);
      const description = embed?.description as string;
      expect(description).toContain('経路: sidecar (idle 検知)');
      expect(description).toContain('snap-12345');
      expect(description).toContain('vol-abcdef');
      expect(description).toContain('snapshot 完成後に自動削除');
      expect(embed?.footer).toEqual({ text: 'instance: i-deadbeef' });
    });

    it('labels cron-fallback path distinctly in description', () => {
      const embed = buildIdleStopNotification(GAME, OK_OUTCOME, 'cron-fallback');
      expect((embed?.description as string)).toContain('Cron フォールバック');
    });

    it('warns when snapshotFailed is true (旧 volume の手動確認を促す)', () => {
      const outcome: StopWorkflowOutcome = {
        status: 'ok',
        instanceId: 'i-x',
        snapshotFailed: true,
        pendingCleanupScheduled: false,
        dnsReset: true,
        dockerStopSucceeded: false,
      };
      const embed = buildIdleStopNotification(GAME, outcome, 'sidecar');
      const description = embed?.description as string;
      expect(description).toContain('⚠️ snapshot 作成に失敗');
      expect(description).not.toContain('snap-'); // snapshot ID は出さない
    });

    it('warns when pendingCleanupScheduled is false (snapshot ありでも cleanup 予約失敗)', () => {
      const outcome: StopWorkflowOutcome = {
        ...OK_OUTCOME,
        pendingCleanupScheduled: false,
      };
      const embed = buildIdleStopNotification(GAME, outcome, 'sidecar');
      const description = embed?.description as string;
      expect(description).toContain('⚠️');
      expect(description).toContain('自動削除予約に失敗');
      expect(description).toContain('手動削除が必要');
    });

    it('warns when dnsReset is false (DNS placeholder 戻し失敗)', () => {
      const outcome: StopWorkflowOutcome = { ...OK_OUTCOME, dnsReset: false };
      const embed = buildIdleStopNotification(GAME, outcome, 'sidecar');
      expect((embed?.description as string)).toContain('DNS A レコードの placeholder 戻しに失敗');
    });

    it('omits volume note when snapshot 無し (= volume 削除予約しないので警告も出さない)', () => {
      const outcome: StopWorkflowOutcome = {
        status: 'ok',
        instanceId: 'i-x',
        pendingCleanupScheduled: false,
        dnsReset: true,
        dockerStopSucceeded: true,
      };
      const embed = buildIdleStopNotification(GAME, outcome, 'sidecar');
      const description = embed?.description as string;
      expect(description).not.toContain('vol-');
      expect(description).not.toContain('自動削除');
    });

    it('sets ISO timestamp on the embed (Discord 側で投稿日時表示に使う)', () => {
      const embed = buildIdleStopNotification(GAME, OK_OUTCOME, 'sidecar');
      expect(typeof embed?.timestamp).toBe('string');
      expect(() => new Date(embed?.timestamp as string).toISOString()).not.toThrow();
    });
  });

  describe('status: failed', () => {
    it('builds a warning embed (⚠️, orange) with error message and recovery hint', () => {
      const outcome: StopWorkflowOutcome = {
        status: 'failed',
        error: 'EC2 RunInstances threw: InsufficientInstanceCapacity',
        instanceId: 'i-broken',
      };
      const embed = buildIdleStopNotification(GAME, outcome, 'cron-fallback');
      expect(embed?.title).toBe('⚠️ All The Mods 11 の自動停止に失敗しました');
      expect(embed?.color).toBe(0xf39c12);
      const description = embed?.description as string;
      expect(description).toContain('経路: Cron フォールバック');
      expect(description).toContain('InsufficientInstanceCapacity');
      expect(description).toContain('AWS コンソールで EC2 が残っていないか');
      expect(embed?.footer).toEqual({ text: 'instance: i-broken' });
    });

    it('truncates very long error messages to 500 chars (Discord embed 上限保護)', () => {
      const outcome: StopWorkflowOutcome = {
        status: 'failed',
        error: 'x'.repeat(2000),
      };
      const embed = buildIdleStopNotification(GAME, outcome, 'sidecar');
      const description = embed?.description as string;
      // 500 chars + 周辺メッセージで <2000 に収まる
      expect((description.match(/x/g) ?? []).length).toBe(500);
    });

    it('omits footer when instanceId is not present (early-stage failure)', () => {
      const outcome: StopWorkflowOutcome = { status: 'failed', error: 'no instance' };
      const embed = buildIdleStopNotification(GAME, outcome, 'sidecar');
      expect(embed?.footer).toBeUndefined();
    });
  });
});

describe('buildCronFailureNotification', () => {
  it('snapshot-retention aws-error: title / color / resource / error head + game line', () => {
    const embed = buildCronFailureNotification({
      eventType: 'snapshot-retention',
      gameId: 'atm11',
      resourceId: 'atm11',
      reason: 'aws-error',
      errorMessage: 'EC2 DescribeSnapshots threw: RequestLimitExceeded',
    });
    expect(embed.title).toBe('⚠️ snapshot 世代管理の Cron が失敗しました');
    expect(embed.color).toBe(0xf39c12);
    const description = embed.description as string;
    expect(description).toContain('game: `atm11`');
    expect(description).toContain('resource: `atm11`');
    expect(description).toContain('RequestLimitExceeded');
    expect(description).toContain('1 時間に 1 回まで通知');
  });

  it('volume-cleanup snapshot-error-state: 専用文面で手動対応の必要を明示', () => {
    const embed = buildCronFailureNotification({
      eventType: 'volume-cleanup',
      gameId: 'atm11',
      resourceId: 'vol-deadbeef',
      reason: 'snapshot-error-state',
      errorMessage: 'snapshot snap-bad entered AWS error state',
    });
    expect(embed.title).toBe('⚠️ volume cleanup の Cron が失敗しました');
    const description = embed.description as string;
    expect(description).toContain('vol-deadbeef');
    expect(description).toContain('snapshot が AWS 側で **error state** に落ちました');
    expect(description).toContain('手動で AWS コンソール確認が必要');
  });

  it('volume-cleanup aws-error: 「次 tick で再試行」を明示 (snapshot-error-state とは別文面)', () => {
    const embed = buildCronFailureNotification({
      eventType: 'volume-cleanup',
      gameId: 'atm11',
      resourceId: 'vol-x',
      reason: 'aws-error',
      errorMessage: 'AccessDenied',
    });
    const description = embed.description as string;
    expect(description).toContain('次 tick で再試行');
    expect(description).not.toContain('手動で AWS コンソール');
  });

  it('omits game line when gameId is undefined (cleanup で entry 紐づけ失敗の保険ケース)', () => {
    const embed = buildCronFailureNotification({
      eventType: 'volume-cleanup',
      resourceId: 'vol-orphan',
      reason: 'aws-error',
      errorMessage: 'err',
    });
    const description = embed.description as string;
    expect(description).not.toMatch(/^game: /m);
    expect(description).toContain('resource: `vol-orphan`');
  });

  it('truncates errorMessage longer than 300 chars and marks (truncated)', () => {
    const embed = buildCronFailureNotification({
      eventType: 'snapshot-retention',
      gameId: 'atm11',
      resourceId: 'atm11',
      reason: 'aws-error',
      // 描画ロジック側の固定文に含まれない文字 ('Z') を payload に使い、純粋に payload 由来分のみ数える。
      errorMessage: 'Z'.repeat(1000),
    });
    const description = embed.description as string;
    expect((description.match(/Z/g) ?? []).length).toBe(300);
    expect(description).toContain('…(truncated)');
  });

  it('sets ISO timestamp (Discord 側で投稿日時表示に使う)', () => {
    const embed = buildCronFailureNotification({
      eventType: 'snapshot-retention',
      resourceId: 'r',
      reason: 'aws-error',
      errorMessage: 'e',
    });
    expect(typeof embed.timestamp).toBe('string');
    expect(() => new Date(embed.timestamp as string).toISOString()).not.toThrow();
  });
});
