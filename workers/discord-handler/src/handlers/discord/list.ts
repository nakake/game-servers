// /list — ゲーム一覧を即時 response で返す。
//
// Phase 1 hardcode: registry.json から直接読む (現在は ATM11 のみ)。
// Phase 2 で Workers KV から取得する形に切り替える。

import { allGames } from '../../lib/registry/atm11.js';
import { InteractionResponseType } from '../../lib/discord/types.js';

export function handleListCommand(): Response {
  const enabled = allGames.filter((g) => g.enabled);
  if (enabled.length === 0) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '登録ゲームがありません' },
    });
  }

  const lines = enabled.map((g) => {
    const port = g.ports[0]?.port ?? '?';
    return `- \`${g.game_id}\` — ${g.display_name} (${g.subdomain}:${port})`;
  });
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `**Game servers**\n${lines.join('\n')}` },
  });
}
