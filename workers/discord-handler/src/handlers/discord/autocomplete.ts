// Discord autocomplete interaction (type 4) のハンドラ。
//
// /start /stop の `game` 引数の候補を GAME_REGISTRY KV から動的に返す。これにより
// ゲーム追加時に Discord コマンド定義 (静的 choices) を再登録する必要がなくなる
// (design.md §4.1: APPLICATION_COMMAND_AUTOCOMPLETE → game choices from KV)。
//
// autocomplete は deferred できない — 3 秒以内に type 8 を返す必要がある。KV list + get は
// 数 ms なので同期 await で間に合う。

import { listGames } from '../../lib/registry/store.js';
import { InteractionResponseType, type Interaction } from '../../lib/discord/types.js';
import type { Env } from '../../env.js';

// Discord の autocomplete choices 上限。
const MAX_CHOICES = 25;

export async function handleAutocomplete(
  interaction: Interaction,
  env: Env,
): Promise<Response> {
  // ユーザーが入力中の option (focused) の現在値で部分一致フィルタする。
  const focused = interaction.data?.options?.find((o) => o.focused === true);
  const partial = typeof focused?.value === 'string' ? focused.value.toLowerCase() : '';

  const games = await listGames(env.GAME_REGISTRY);
  const choices = games
    .filter((g) => g.enabled)
    .filter(
      (g) =>
        g.game_id.toLowerCase().includes(partial) ||
        g.display_name.toLowerCase().includes(partial),
    )
    .slice(0, MAX_CHOICES)
    .map((g) => ({ name: `${g.display_name} (${g.game_id})`, value: g.game_id }));

  return Response.json({
    type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
  });
}
