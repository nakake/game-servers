// AWS SNS HTTPS subscription の payload 型 (Phase 1 で使う範囲)。
//
// 参照: https://docs.aws.amazon.com/sns/latest/dg/sns-message-and-json-formats.html

export interface SnsBaseMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
}

export interface SnsSubscriptionConfirmation extends SnsBaseMessage {
  Type: 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  Token: string;
  Message: string;
  // SubscribeURL を GET すると AWS 側で subscription 状態が "Confirmed" になる。
  SubscribeURL: string;
}

export interface SnsNotification extends SnsBaseMessage {
  Type: 'Notification';
  Subject?: string;
  Message: string; // JSON string or plain text
  UnsubscribeURL: string;
}

export type SnsMessage = SnsSubscriptionConfirmation | SnsNotification;

export function isSubscriptionConfirmation(msg: SnsMessage): msg is SnsSubscriptionConfirmation {
  return msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation';
}

export function isNotification(msg: SnsMessage): msg is SnsNotification {
  return msg.Type === 'Notification';
}
