// /list — 登録ゲーム一覧を即時 response で返す。
//
// GAME_REGISTRY KV から読む (Phase 2)。KV get は数 ms で済むため、Discord の 3 秒制約内に
// 同期 await して即時 response (type 4) を返せる。

import { listGames } from '../../lib/registry/store.js';
import { InteractionResponseType } from '../../lib/discord/types.js';
import type { Env } from '../../env.js';

export async function handleListCommand(env: Env): Promise<Response> {
  const games = await listGames(env.GAME_REGISTRY);
  const enabled = games.filter((g) => g.enabled);
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
