// Discord channel webhook への投稿ヘルパー (Phase 4)。
//
// Worker 内のどこからでも同じ payload 規約で channel webhook に投げられるようにする:
//   - 汎用 AWS アラート (aws-notification.ts、embed 投稿)
//   - ゲーム起動完了通知 (aws-notification.ts、content + mention)
//   - idle 自動停止通知 (handlers/stop.ts、Phase 4 Step 2 で追加)
//   - snapshot 削除失敗通知 (handlers/snapshot-retention.ts、Phase 4 Step 4 で追加)
//
// 設計方針:
//   - env.DISCORD_WEBHOOK_URL 未設定なら warn して早期 return (false)。これは Phase 1 の
//     挙動を踏襲 — 通知の宛先が無い状態でも Worker 本体は動き続ける。
//   - fetch / response 失敗も warn ログのみ、throw しない (boolean で結果を返す)。
//     呼び出し側 (e.g. SNS handler) が「失敗時に 502 を返して再送させる」判断を
//     したい場合は戻り値で分岐できる。
//   - mention ping は明示した user_id のみ。@everyone / @here / role の暴発防止に
//     allowed_mentions.parse = [] を常に付ける。

import type { Env } from '../../env.js';

export interface DiscordWebhookPayload {
  // plain text 本文。embed のみ送りたい場合は省略可。
  content?: string;
  // Discord embed object の配列 (最大 10、合計 6000 chars)。呼び出し側で構築。
  embeds?: Record<string, unknown>[];
  // ping 対象の user id。指定した user だけ push 通知される (parse:[] で everyone/role を抑止)。
  mentionUserIds?: string[];
}

// Discord channel webhook に投稿する。
// 戻り値: 投稿が HTTP 2xx で受理されたか。env 未設定 / fetch 失敗 / 非 2xx は false。
// 失敗時も throw しないので、呼び出し側で「失敗してもフロー継続」が容易。
export async function postDiscordWebhookMessage(
  env: Env,
  payload: DiscordWebhookPayload,
): Promise<boolean> {
  if (env.DISCORD_WEBHOOK_URL === undefined || env.DISCORD_WEBHOOK_URL === '') {
    console.warn('DISCORD_WEBHOOK_URL not configured; dropping webhook message');
    return false;
  }

  const body: Record<string, unknown> = {};
  if (payload.content !== undefined) {
    body.content = payload.content;
  }
  if (payload.embeds !== undefined && payload.embeds.length > 0) {
    body.embeds = payload.embeds;
  }
  // content も embeds も無い payload は Discord が 400 を返す。呼び出し側のバグを早期に
  // 顕在化させるため warn してから return (実 fetch しない)。
  if (body.content === undefined && body.embeds === undefined) {
    console.warn('postDiscordWebhookMessage called with neither content nor embeds; skipping');
    return false;
  }

  // mention の暴発防止。明示 user だけ ping、それ以外 (@everyone / role) は parse から除外。
  const allowedMentions: Record<string, unknown> = { parse: [] };
  if (payload.mentionUserIds !== undefined && payload.mentionUserIds.length > 0) {
    allowedMentions.users = payload.mentionUserIds;
  }
  body.allowed_mentions = allowedMentions;

  let response: Response;
  try {
    response = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn('Discord webhook POST threw (network error):', err);
    return false;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '<failed to read body>');
    console.warn(`Discord webhook POST failed (${response.status}):`, text.slice(0, 300));
    return false;
  }
  return true;
}
