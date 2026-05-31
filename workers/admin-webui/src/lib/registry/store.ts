// GAME_REGISTRY KV へのアクセス (admin-webui 側、Phase 7 B-3)。
//
// 本番 KV の key は **素の game_id** (register-game.mjs が put し、discord-handler の
// lib/registry/store.ts も素の game_id で読む)。設計書 §5.2 の `game:<id>` プレフィックス案は
// 採用せず、本番の現行スキーマに合わせる。
//
// admin-webui は読み取り (一覧/取得) と書き込み (更新/新規) の両方を行う。書き込みは
// discord-handler 側には無い admin-webui 固有の操作。

import type { GameDefinition } from "@gs/shared/registry-types";

// 1 ゲームを引く。未登録 / 壊れた JSON なら undefined。
export async function getGame(
  kv: KVNamespace,
  gameId: string,
): Promise<GameDefinition | undefined> {
  const game = await kv.get<GameDefinition>(gameId, "json");
  return game ?? undefined;
}

// 登録済み全ゲーム。KV list はキー名昇順。ゲーム数は小規模で list の 1000 件上限・
// ページネーションには当たらない前提 (discord-handler の store.ts と同じ流儀)。
export async function listGames(kv: KVNamespace): Promise<GameDefinition[]> {
  const { keys } = await kv.list();
  const games = await Promise.all(
    keys.map((k) => kv.get<GameDefinition>(k.name, "json")),
  );
  return games.filter((g): g is GameDefinition => g !== null);
}

// GameDefinition を保存する (key=game_id)。更新・新規どちらも put で上書き。
export async function putGame(
  kv: KVNamespace,
  game: GameDefinition,
): Promise<void> {
  await kv.put(game.game_id, JSON.stringify(game));
}
