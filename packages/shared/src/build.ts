// NewGameForm → GameDefinition 変換と、コスト系 field の tier 別解決。
//
// ADR 0004: このパッケージには AWS / OIDC ロジックを入れない (鍵隔離)。純粋変換のみ。
// 完全な buildGameDefinition (registry.json 全体の組み立て) は Phase 7 D-2 で
// scripts/register-game.mjs の処理を移植して実装する。B-0a では tier 別の
// コスト field 解決 — security 上 load-bearing な部分 — だけを先に実装する。

import type { CostFields, GameDefinition, Tier } from "./registry-types.js";

// player の新規追加 / admin が省略した場合に強制するサーバ側既定 (docs §5.3)。
export const COST_FIELD_DEFAULTS: CostFields = {
  memory_gb: 8,
  instance_types: ["r7a.large", "r6a.large"],
  ebs_size_gb: 30,
  spot_max_price_jpy_per_hour: null,
};

// requester の tier に応じてコスト系 field を確定する。
//
// **enforcement の本体** (docs §9.1 #2b): player はコスト field を送ってきても無視し、
// 必ず COST_FIELD_DEFAULTS を適用する。admin のみ要求値を採用 (未指定は既定で補完)。
// UI 非表示は UX に過ぎず、実ガードはこのサーバ側関数で行う。
export function resolveCostFields(
  requested: Partial<CostFields> | undefined,
  tier: Tier,
): CostFields {
  if (tier !== "admin" || !requested) {
    return { ...COST_FIELD_DEFAULTS };
  }
  return {
    memory_gb: requested.memory_gb ?? COST_FIELD_DEFAULTS.memory_gb,
    instance_types:
      requested.instance_types ?? COST_FIELD_DEFAULTS.instance_types,
    ebs_size_gb: requested.ebs_size_gb ?? COST_FIELD_DEFAULTS.ebs_size_gb,
    spot_max_price_jpy_per_hour:
      requested.spot_max_price_jpy_per_hour ??
      COST_FIELD_DEFAULTS.spot_max_price_jpy_per_hour,
  };
}

// env 内でコスト・サーバサイズに直結する key (top-level とは別扱い、docs §1.1 / §5.3)。
const COST_ENV_KEY = "MEMORY";

// 既存 GameDefinition に部分更新を適用する (PUT /admin/api/games/:id の中核)。
//
// **enforcement の本体** (docs §9.1 #2b / §6): tier!=='admin' のときコスト系 field
// (instance_types / ebs_size_gb / spot_max_price_jpy_per_hour / env.MEMORY) を更新値から
// **無視して既存値を強制復元**する。CF_FILE_ID 等の非コスト env / 非コスト field は player も
// 更新できる。UI 非表示に依存せずサーバ側でガードする純粋関数。
//
// - game_id は不変 (更新で変えられない)。
// - env は「既存 env に update.env をマージ」する (player が CF_FILE_ID だけ差し替えられる)。
//   その上で player の場合 env.MEMORY は既存値に戻す。
export function applyGameUpdate(
  existing: GameDefinition,
  update: Partial<GameDefinition>,
  tier: Tier,
): GameDefinition {
  const merged: GameDefinition = {
    ...existing,
    ...update,
    // game_id は URL の id 側を正とし、更新で変えさせない。
    game_id: existing.game_id,
  };

  // env はマージ (update.env の指定キーだけ上書き、他は既存維持)。
  if (update.env !== undefined) {
    merged.env = { ...existing.env, ...update.env };
  }

  if (tier !== "admin") {
    // コスト系 top-level field を既存値に強制復元 (個別代入で型安全に)。
    merged.instance_types = existing.instance_types;
    merged.ebs_size_gb = existing.ebs_size_gb;
    merged.spot_max_price_jpy_per_hour = existing.spot_max_price_jpy_per_hour;
    // env.MEMORY を既存値に戻す (キーが無ければ player 由来の MEMORY を落とす)。
    const env = { ...merged.env };
    const existingMemory = existing.env[COST_ENV_KEY];
    if (existingMemory !== undefined) {
      env[COST_ENV_KEY] = existingMemory;
    } else {
      delete env[COST_ENV_KEY];
    }
    merged.env = env;
  }

  return merged;
}
