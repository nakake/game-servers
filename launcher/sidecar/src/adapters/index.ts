// `idle_check.type` から adapter を引く dispatch。Phase 3 では `minecraft_rcon` のみ実装、
// 他は明示 throw して Phase 6 (新ゲーム追加実証) で実装する旨を残す。
// docs/phase3-plan.md の §Phase 3 で扱わないもの参照。

import type { IdleAdapter } from './types.js';
import { minecraftRconAdapter } from './minecraft-rcon.js';

export function getAdapter(type: string): IdleAdapter {
  switch (type) {
    case 'minecraft_rcon':
      return minecraftRconAdapter;
    case 'tshock_rest':
    case 'steam_query':
    case 'factorio_rcon':
      throw new Error(
        `idle_check.type "${type}" is not implemented in Phase 3 (deferred to Phase 6 / new-game proof)`,
      );
    default:
      throw new Error(`unknown idle_check.type: "${type}"`);
  }
}

export type { IdleAdapter, IdleAdapterContext, AdapterCheckResult } from './types.js';
