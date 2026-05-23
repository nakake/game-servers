import { describe, expect, it } from 'vitest';

import { inferSeverity, isSpotInterruptionMessage } from './aws-notification.js';
import type { SnsNotification } from '../lib/sns/types.js';

function notif(overrides: Partial<SnsNotification> = {}): SnsNotification {
  // exactOptionalPropertyTypes 環境下では undefined を value として渡せないので、
  // optional な Subject はベースから外し、overrides で指定された時だけ展開する。
  const base: SnsNotification = {
    Type: 'Notification',
    MessageId: 'msg-1',
    TopicArn: 'arn:aws:sns:ap-northeast-1:000000000000:gs-alerts',
    Timestamp: '2026-05-24T07:00:00.000Z',
    SignatureVersion: '1',
    Signature: '',
    SigningCertURL: '',
    UnsubscribeURL: '',
    Message: '',
  };
  return { ...base, ...overrides };
}

describe('inferSeverity', () => {
  it('returns critical when Message contains "interruption" (Spot 中断警告経路)', () => {
    const msg = notif({
      Message:
        'Spot interruption warning: instance i-deadbeef (ap-northeast-1); ' +
        'action=terminate; reclaimed in ~2 min; event time 2026-05-24T07:00:00Z',
    });
    expect(inferSeverity(msg)).toBe('critical');
  });

  it('returns critical for "alarm" / "critical" / "unauthorized" 含む文面', () => {
    expect(inferSeverity(notif({ Message: 'CloudWatch ALARM fired' }))).toBe('critical');
    expect(inferSeverity(notif({ Subject: 'Critical: investigate', Message: 'x' }))).toBe(
      'critical',
    );
    expect(inferSeverity(notif({ Message: 'UnauthorizedOperation: ...' }))).toBe('critical');
  });

  it('returns warning for "budget" / "failed" 含む文面', () => {
    expect(inferSeverity(notif({ Subject: 'AWS Budgets alert' }))).toBe('warning');
    expect(inferSeverity(notif({ Message: 'Snapshot delete failed: ...' }))).toBe('warning');
  });

  it('returns info for unrelated content (デフォルト)', () => {
    expect(inferSeverity(notif({ Message: 'Just an FYI message' }))).toBe('info');
  });

  it('handles missing Subject without throwing', () => {
    // Subject を渡さない (omit) ことで undefined を再現。EventBridge → SNS 経路はこの形になる。
    expect(() => inferSeverity(notif({ Message: 'plain' }))).not.toThrow();
  });
});

describe('isSpotInterruptionMessage', () => {
  it('detects EventBridge input_transformer の固定 prefix', () => {
    const msg = notif({
      Message:
        'Spot interruption warning: instance i-deadbeef (ap-northeast-1); action=terminate; ' +
        'reclaimed in ~2 min; event time 2026-05-24T07:00:00Z',
    });
    expect(isSpotInterruptionMessage(msg)).toBe(true);
  });

  it('returns false for unrelated AWS alerts (Budgets / Alarm など)', () => {
    expect(isSpotInterruptionMessage(notif({ Message: 'AWS Budgets exceeded' }))).toBe(false);
    expect(isSpotInterruptionMessage(notif({ Message: 'CloudWatch ALARM: latency' }))).toBe(false);
  });

  it('is case-sensitive on the prefix (誤検知を避ける)', () => {
    // input_template が小文字で始まると false (実 EventBridge は大文字 S 固定なので問題ない)。
    expect(isSpotInterruptionMessage(notif({ Message: 'spot interruption warning: ...' }))).toBe(
      false,
    );
  });

  it('rejects messages that mention interruption mid-text but not at start', () => {
    // generic embed 経路に流す: severity は inferSeverity で critical になるが、専用整形は出さない。
    expect(
      isSpotInterruptionMessage(notif({ Message: 'CloudTrail: spot interruption pattern matched' })),
    ).toBe(false);
  });
});
