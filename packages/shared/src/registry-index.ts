// GAME_REGISTRY の game_id 一覧 (registry-index) の共有契約。
//
// index は SERVER_STATE KV に置くキャッシュで、値は game_id の JSON 配列 (昇順)。
// source of truth は GAME_REGISTRY のキーそのもの — index が無い / 壊れているときは
// list から作り直す (discord-handler の lib/registry/store.ts)。
// scripts/register-game.mjs は TS を import できないため、キー名と TTL を複製して持つ。
// 変えるときは両方直すこと。

// SERVER_STATE 上のキー。
export const REGISTRY_INDEX_KEY = "registry-index";
// index の寿命 (秒)。失効後は次の listGames が list から作り直す。
export const REGISTRY_INDEX_TTL_SECONDS = 3600;

// KV から読んだ生値を id 配列として検証する。要素がすべて string の、長さ 1 以上の
// 配列だけを受理し、それ以外 (null / 非配列 / 空配列 / 非文字列要素の混入) は undefined。
// 空配列を hit 扱いにすると全ゲームが TTL の間見えなくなるため、miss に倒す。
export function parseRegistryIndex(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!raw.every((entry): entry is string => typeof entry === "string")) {
    return undefined;
  }
  return raw;
}
