// Phase 1 hardcode: games/atm11/registry.json を直接 import する。
//
// Phase 2 で Workers KV (GAME_REGISTRY) に投入し、`getGameDefinition(gameId)` で KV から
// 引く形に切り替える。スキーマ自体 (GameDefinition) は同じ。

import atm11RegistryRaw from '../../../../../games/atm11/registry.json' with { type: 'json' };

import type { GameDefinition } from './types.js';

// JSON import の型は wide な構造になるので、GameDefinition で narrow に絞り直す。
// runtime チェックはしない (registry.json は手元管理のためコミット時点で形式整合済み前提)。
export const atm11Registry = atm11RegistryRaw as unknown as GameDefinition;

// Phase 1 hardcode 用: 全ゲーム一覧 (現在は ATM11 のみ)。
export const allGames: GameDefinition[] = [atm11Registry];

export function getGameById(gameId: string): GameDefinition | undefined {
  return allGames.find((g) => g.game_id === gameId);
}
