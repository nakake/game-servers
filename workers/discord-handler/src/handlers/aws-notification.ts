// AWS SNS → Discord 集約 (design.md §4.6)。
//
// 2 系統の通知を扱う:
//   1. ゲーム起動完了通知 — launcher が container log の 'Done (' 検知後に
//      Subject "<game_id> ready" で publish する。/start を叩いた本人向けに、
//      /start の元メッセージ (🟡 準備中) を ✅ に編集し、起動した人を mention して知らせる。
//   2. 汎用 AWS アラート — Budgets / CloudWatch Alarm / Spot interruption など。
//      従来どおり channel webhook に embed 投稿する。
//
// セキュリティ (Phase 1 hardcode):
//   - TopicArn allow list で env.SNS_ALLOWED_TOPIC_ARN と一致するものだけ処理
//   - SNS signature 検証は Phase 4 で追加 (SigningCertURL から SHA256/SHA1 検証)
//
// 参照: https://docs.aws.amazon.com/sns/latest/dg/sns-http-https-endpoint-as-subscriber.html

import { DiscordFollowUpClient } from '../lib/discord/follow-up.js';
import { postDiscordWebhookMessage } from '../lib/discord/webhook.js';
import { getGame } from '../lib/registry/store.js';
import {
  isNotification,
  isSubscriptionConfirmation,
  type SnsMessage,
  type SnsNotification,
  type SnsSubscriptionConfirmation,
} from '../lib/sns/types.js';
import { deletePendingReady, getPendingReady } from '../lib/state/pending-ready.js';
import type { Env } from '../env.js';

// Discord embed color (decimal)
const COLOR_CRITICAL = 0xdc2626; // red
const COLOR_WARNING = 0xf59e0b;  // amber
const COLOR_INFO = 0x10b981;     // green

type Severity = 'critical' | 'warning' | 'info';

export async function handleAwsNotification(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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
    return handleNotification(payload, env, ctx);
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

async function handleNotification(
  msg: SnsNotification,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ゲーム起動完了通知か判定 (Subject = "<game_id> ready" かつ既知の game)。
  const readyGameId = parseGameReadySubject(msg.Subject);
  if (
    readyGameId !== undefined &&
    (await getGame(env.GAME_REGISTRY, readyGameId)) !== undefined
  ) {
    // Discord への配信は API を数回叩くので waitUntil で後追いし、SNS には即 200 を返す。
    // (502 等を返すと SNS が再送し、ready メッセージが重複投稿されるため。)
    ctx.waitUntil(deliverGameReady(readyGameId, env));
    return new Response('game ready notification accepted\n');
  }

  // --- 汎用 AWS アラート: channel webhook に embed 投稿 ---
  // env 未設定は本 Worker の運用設定不備なので 500 で返し、それ以外の Discord 側の
  // 一過性エラーは 502 で返して SNS に再送させる (現行挙動の踏襲)。
  if (env.DISCORD_WEBHOOK_URL === undefined || env.DISCORD_WEBHOOK_URL === '') {
    console.error('DISCORD_WEBHOOK_URL not configured; dropping SNS notification');
    return new Response('DISCORD_WEBHOOK_URL not configured\n', { status: 500 });
  }

  const severity = inferSeverity(msg);
  const embed = buildDiscordEmbed(msg, severity);

  const ok = await postDiscordWebhookMessage(env, { embeds: [embed] });
  if (!ok) {
    return new Response('Discord webhook failed\n', { status: 502 });
  }
  return new Response('notification delivered\n');
}

// Subject "<game_id> ready" から game_id を取り出す。形式が違えば undefined。
// (launcher の user-data が `aws sns publish --subject "<game_id> ready"` で送る。)
function parseGameReadySubject(subject: string | undefined): string | undefined {
  if (subject === undefined) {
    return undefined;
  }
  const match = /^(\S+)\s+ready$/.exec(subject.trim());
  return match?.[1];
}

// ゲーム起動完了を Discord に配信する:
//   1. /start の元メッセージ (🟡 準備中) を ✅ に編集する (best-effort)。
//   2. 起動した人を mention して通知する。
//      Discord は「編集」では push 通知を出さないため、ping は別メッセージの「作成」で行う。
//      follow-up POST (= /start と同じ channel) を優先し、token 失効時は channel webhook。
//
// interaction token は 15 分で失効する。ATM11 初回ブートは mod ロードで 15 分を超える
// ことがあり、その場合 1.2 は webhook フォールバックに落ちる (元メッセージ編集は skip)。
async function deliverGameReady(gameId: string, env: Env): Promise<void> {
  const game = await getGame(env.GAME_REGISTRY, gameId);
  if (game === undefined) {
    return;
  }

  const fqdn = `${game.subdomain}.${env.CLOUDFLARE_BASE_DOMAIN}`;
  const port = game.ports[0]?.port ?? 25565;
  const announcement =
    `✅ ${game.display_name}: ${game.discord.ready_message}\n` +
    `\`${fqdn}:${port}\` で接続できます`;

  const pending = await getPendingReady(env.SERVER_STATE, gameId).catch(() => undefined);

  // KV に文脈が無い (TTL 切れ / 同 game の /start を打っていない) → mention 無しで webhook のみ。
  if (pending === undefined) {
    await postDiscordWebhookMessage(env, { content: announcement });
    return;
  }

  const followUp = new DiscordFollowUpClient({
    applicationId: pending.applicationId,
    interactionToken: pending.interactionToken,
  });

  // 1. /start の元メッセージ (🟡 準備中) を ✅ に編集 (best-effort、token 15 分制限)。
  try {
    await followUp.editOriginal(announcement);
  } catch (err) {
    console.error(`game-ready editOriginal failed (${gameId}):`, err);
  }

  // 2. 起動した人を mention して通知。編集では ping されないため別メッセージを作成する。
  const mention = pending.userId !== undefined ? `<@${pending.userId}>\n` : '';
  let delivered = false;
  try {
    await followUp.createFollowUp(
      `${mention}${announcement}`,
      pending.userId !== undefined ? { mentionUserIds: [pending.userId] } : {},
    );
    delivered = true;
  } catch (err) {
    console.error(`game-ready createFollowUp failed (${gameId}); falling back to webhook:`, err);
  }

  // follow-up POST が失敗 (token 失効など) → channel webhook で新規メッセージ。
  if (!delivered) {
    await postDiscordWebhookMessage(env, {
      content: `${mention}${announcement}`,
      ...(pending.userId !== undefined ? { mentionUserIds: [pending.userId] } : {}),
    });
  }

  // 配信できたら KV を消す (SNS 再送による二重通知を防ぐ)。
  await deletePendingReady(env.SERVER_STATE, gameId).catch(() => undefined);
}

export function inferSeverity(msg: SnsNotification): Severity {
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
  // EventBridge → SNS で input_transformer により整形された Spot 中断警告は専用整形で出す。
  // Subject が空 (EventBridge input_transformer は Subject を載せない) のため、generic 整形に
  // 任せると title が "AWS notification" になってしまい一目で内容が分からない。
  if (isSpotInterruptionMessage(msg)) {
    return buildSpotInterruptionEmbed(msg);
  }

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

// EventBridge rule `gs-spot-interruption-warning` (infra/envs/prod/eventbridge.tf) の
// input_template が "Spot interruption warning: ..." で始まる固定文を SNS に流す契約。
// この prefix を見て判定する (Subject は EventBridge input_transformer 経由だと空)。
export function isSpotInterruptionMessage(msg: SnsNotification): boolean {
  return msg.Message.startsWith('Spot interruption warning:');
}

// Spot 中断警告専用 embed。critical color + 「2 分以内に reclaim、手動 /stop でしか間に合わない」
// を 1 行目に出して、原文 (instance-id / region / action / time) を付録として残す。
//
// design.md §11 の Open Question「Spot 中断時の自動 graceful stop」は本フェーズでは見送り
// (Phase 4 計画 Step 3、決定: Phase 5+ で再評価)。ユーザーが Discord を見て手動 /stop する
// しか道が無いため、message では行動を急かす文面を最優先にする。
function buildSpotInterruptionEmbed(msg: SnsNotification): Record<string, unknown> {
  const description =
    '⚠️ **約 2 分以内に EC2 が Spot reclaim されます。**\n' +
    'セーブを優先したい場合は今すぐ手動 `/stop` を叩いてください ' +
    '(本フェーズでは自動 graceful stop は走りません)。\n\n' +
    `---\n${msg.Message}`;

  return {
    title: '🚨 Spot 中断警告 (約 2 分で EC2 回収)',
    description,
    color: COLOR_CRITICAL,
    timestamp: msg.Timestamp,
    footer: { text: msg.TopicArn },
  };
}
