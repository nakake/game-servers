// GAME_REGISTRY KV からゲーム定義 (registry.json) を読む。
//
// Phase 1 の lib/registry/atm11.ts (games/atm11/registry.json を build-time import) を
// 置き換える。KV のキー = game_id、値 = registry.json の JSON。投入は scripts/register-game.mjs。
//
// KVNamespace を直接受け取る (Env 全体ではなく) — lib/state/pending-*.ts と同じ流儀。

import type { GameDefinition } from './types.js';

// 1 ゲームを引く。未登録なら undefined。
export async function getGame(
  kv: KVNamespace,
  gameId: string,
): Promise<GameDefinition | undefined> {
  const game = await kv.get<GameDefinition>(gameId, 'json');
  return game ?? undefined;
}

// 登録済み全ゲーム。KV list はキー名昇順で返す。ゲーム数は小規模で、list の 1000 件
// 上限・ページネーションには当たらない前提 (超えたら cursor 対応が要る)。
export async function listGames(kv: KVNamespace): Promise<GameDefinition[]> {
  const { keys } = await kv.list();
  const games = await Promise.all(
    keys.map((k) => kv.get<GameDefinition>(k.name, 'json')),
  );
  return games.filter((g): g is GameDefinition => g !== null);
}
