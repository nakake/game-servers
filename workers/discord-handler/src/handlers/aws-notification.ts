// AWS SNS → Discord webhook 集約 (design.md §4.6)。
//
// 用途: AWS Budgets / EventBridge / CloudWatch Alarm からの通知を SNS 経由で受け取り,
// Discord channel webhook に整形投稿する.
//
// セキュリティ (Phase 1 hardcode):
//   - TopicArn allow list で env.SNS_ALLOWED_TOPIC_ARN と一致するものだけ処理
//   - SNS signature 検証は Phase 4 で追加 (SigningCertURL から SHA256/SHA1 検証)
//
// 参照: https://docs.aws.amazon.com/sns/latest/dg/sns-http-https-endpoint-as-subscriber.html

import {
  isNotification,
  isSubscriptionConfirmation,
  type SnsMessage,
  type SnsNotification,
  type SnsSubscriptionConfirmation,
} from '../lib/sns/types.js';
import type { Env } from '../env.js';

// Discord embed color (decimal)
const COLOR_CRITICAL = 0xdc2626; // red
const COLOR_WARNING = 0xf59e0b;  // amber
const COLOR_INFO = 0x10b981;     // green

type Severity = 'critical' | 'warning' | 'info';

export async function handleAwsNotification(request: Request, env: Env): Promise<Response> {
  const messageType = request.headers.get('x-amz-sns-message-type');
  if (messageType === null) {
    return new Response('missing x-amz-sns-message-type header\n', { status: 400 });
  }

  let payload: SnsMessage;
  try {
    payload = (await request.json()) as SnsMessage;
  } catch {
    return new Response('invalid JSON body\n', { status: 400 });
  }

  // TopicArn allow list (env が設定されていれば一致を要求)
  if (env.SNS_ALLOWED_TOPIC_ARN !== undefined && env.SNS_ALLOWED_TOPIC_ARN !== '') {
    if (payload.TopicArn !== env.SNS_ALLOWED_TOPIC_ARN) {
      return new Response('topic not allowed\n', { status: 403 });
    }
  }

  if (isSubscriptionConfirmation(payload)) {
    return handleSubscriptionConfirmation(payload);
  }
  if (isNotification(payload)) {
    return handleNotification(payload, env);
  }
  return new Response(`unsupported message type: ${messageType}\n`, { status: 400 });
}

async function handleSubscriptionConfirmation(
  msg: SnsSubscriptionConfirmation,
): Promise<Response> {
  // SubscribeURL を GET すると AWS 側で subscription が confirm される。
  const response = await fetch(msg.SubscribeURL, { method: 'GET' });
  if (!response.ok) {
    const body = await response.text();
    console.error(`SNS SubscribeURL GET failed (${response.status}):`, body);
    return new Response(`SubscribeURL fetch failed: HTTP ${response.status}\n`, { status: 500 });
  }
  return new Response('subscription confirmed\n');
}

async function handleNotification(msg: SnsNotification, env: Env): Promise<Response> {
  if (env.DISCORD_WEBHOOK_URL === undefined || env.DISCORD_WEBHOOK_URL === '') {
    console.error('DISCORD_WEBHOOK_URL not configured; dropping SNS notification');
    return new Response('DISCORD_WEBHOOK_URL not configured\n', { status: 500 });
  }

  const severity = inferSeverity(msg);
  const embed = buildDiscordEmbed(msg, severity);

  const response = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(`Discord webhook POST failed (${response.status}):`, body);
    return new Response(`Discord webhook failed: HTTP ${response.status}\n`, { status: 502 });
  }
  return new Response('notification delivered\n');
}

function inferSeverity(msg: SnsNotification): Severity {
  // Subject ベースで判定。実運用では SNS 側で message attribute に severity を載せる手もある。
  const subject = msg.Subject ?? '';
  const text = `${subject}\n${msg.Message}`.toLowerCase();
  if (
    text.includes('alarm') ||
    text.includes('critical') ||
    text.includes('interruption') ||      // Spot interruption warning
    text.includes('unauthorized')
  ) {
    return 'critical';
  }
  if (
    text.includes('budget') ||
    text.includes('warning') ||
    text.includes('failure') ||
    text.includes('failed')
  ) {
    return 'warning';
  }
  return 'info';
}

function buildDiscordEmbed(msg: SnsNotification, severity: Severity): Record<string, unknown> {
  const color =
    severity === 'critical' ? COLOR_CRITICAL : severity === 'warning' ? COLOR_WARNING : COLOR_INFO;
  const icon = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';

  // Discord description は 4096 chars 上限。安全に 3500 で truncate。
  const description = msg.Message.length > 3500
    ? `${msg.Message.slice(0, 3500)}\n\n…(truncated)`
    : msg.Message;

  return {
    title: `${icon} ${msg.Subject ?? 'AWS notification'}`,
    description,
    color,
    timestamp: msg.Timestamp,
    footer: { text: msg.TopicArn },
  };
}
