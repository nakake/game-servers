// /panel — modpack 管理 WebUI への magic link を発行する (Phase 7 B-2、ADR 0003)。
//
// 動線: ユーザーが /panel → ephemeral message + link button (`<ADMIN_BASE_URL>/auth?t=<token>`)。
// button を踏むと admin-webui の /auth が token を検証し session cookie を発行する。
//
// セキュリティ上の要 (docs §9.1):
//   - **flags: 64 (EPHEMERAL) は load-bearing**。token は bearer なので、応答が channel 全員に
//     見えると 5 分以内に誰でも発行者として入れてしまう。ephemeral を必ず付ける (test で担保)。
//   - token は 32 bytes CSPRNG / one-shot / TTL 300s。tier の allowlist 判定は admin-webui の
//     /auth 側で行う (ここでは誰が叩いても token を発行する。クリック後に fail-closed 判定)。
//   - token を **ログに出さない** (wrangler tail から漏れる、docs §9.1 #6)。
//
// KV put は数 ms で済むため deferred ではなく即時 response (type 4) を返す (3 秒制約内)。

import {
  ADMIN_TOKEN_TTL_SECONDS,
  adminTokenKey,
  generateOpaqueToken,
  type AdminTokenRecord,
} from "@gs/shared/auth-types";
import { InteractionResponseType } from "../../lib/discord/types.js";
import type { Interaction } from "../../lib/discord/types.js";
import type { Env } from "../../env.js";

const EPHEMERAL_FLAG = 64;

export async function handlePanelCommand(
  interaction: Interaction,
  env: Env,
): Promise<Response> {
  const userId = extractUserId(interaction);
  if (userId === undefined) {
    return ephemeralMessage(
      "ユーザー情報を取得できませんでした。サーバー内で実行してください。",
    );
  }

  const baseUrl = normalizeBaseUrl(env.ADMIN_BASE_URL);
  if (baseUrl === undefined) {
    // 設定漏れ。利用者には簡潔に、運用者には log で気付けるように。
    console.warn("[panel] ADMIN_BASE_URL is not configured");
    return ephemeralMessage(
      "管理画面の URL が未設定です。管理者に連絡してください。",
    );
  }

  const token = generateOpaqueToken();
  const now = Date.now();
  const record: AdminTokenRecord = {
    user_id: userId,
    issued_at: now,
    exp_ts: now + ADMIN_TOKEN_TTL_SECONDS * 1000,
    used: false,
  };
  await env.ADMIN_AUTH.put(adminTokenKey(token), JSON.stringify(record), {
    expirationTtl: ADMIN_TOKEN_TTL_SECONDS,
  });

  // token を URL に乗せるが、ログには出さない (ephemeral 応答にのみ含める)。
  const url = `${baseUrl}/auth?t=${token}`;
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: EPHEMERAL_FLAG,
      content:
        "管理画面を開くリンクを発行しました（**5 分間有効・あなたにのみ表示**・1 回限り）。",
      components: [
        {
          type: 1, // action row
          components: [
            {
              type: 2, // button
              style: 5, // link
              label: "管理画面を開く",
              url,
            },
          ],
        },
      ],
    },
  });
}

// guild では member.user.id、DM では user.id に入る。
function extractUserId(interaction: Interaction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

// 末尾スラッシュを除いた base URL。未設定 / 空なら undefined。
function normalizeBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw.replace(/\/+$/, "");
}

function ephemeralMessage(content: string): Response {
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: EPHEMERAL_FLAG, content },
  });
}
