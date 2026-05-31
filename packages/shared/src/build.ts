// NewGameForm → GameDefinition 変換と、コスト系 field の tier 別解決。
//
// ADR 0004: このパッケージには AWS / OIDC ロジックを入れない (鍵隔離)。純粋変換のみ。
// 完全な buildGameDefinition (registry.json 全体の組み立て) は Phase 7 D-2 で
// scripts/register-game.mjs の処理を移植して実装する。B-0a では tier 別の
// コスト field 解決 — security 上 load-bearing な部分 — だけを先に実装する。

import type { CostFields, Tier } from "./registry-types.js";

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
