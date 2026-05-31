import { describe, expect, it } from "vitest";

import {
  COST_FIELD_DEFAULTS,
  applyGameUpdate,
  resolveCostFields,
} from "./build.js";
import type { GameDefinition } from "./registry-types.js";

describe("resolveCostFields", () => {
  it("forces defaults for player regardless of requested values", () => {
    const result = resolveCostFields(
      {
        memory_gb: 64,
        ebs_size_gb: 999,
        instance_types: ["x.huge"],
        spot_max_price_jpy_per_hour: 5,
      },
      "player",
    );
    expect(result).toEqual(COST_FIELD_DEFAULTS);
  });

  it("accepts admin-provided values and fills gaps with defaults", () => {
    const result = resolveCostFields({ memory_gb: 16 }, "admin");
    expect(result.memory_gb).toBe(16);
    expect(result.instance_types).toEqual(COST_FIELD_DEFAULTS.instance_types);
  });

  it("returns defaults for admin when nothing requested", () => {
    expect(resolveCostFields(undefined, "admin")).toEqual(COST_FIELD_DEFAULTS);
  });
});

function baseGame(over: Partial<GameDefinition> = {}): GameDefinition {
  return {
    game_id: "atm10",
    display_name: "All The Mods 10",
    category: "minecraft-modded",
    enabled: true,
    instance_types: ["r7a.large", "r6a.large"],
    ebs_size_gb: 30,
    spot_max_price_jpy_per_hour: 12,
    subdomain: "atm10",
    cf_record_id: "rec-1",
    ports: [{ port: 25565, proto: "TCP" }],
    container_image: "itzg/minecraft-server:java21",
    image_source: "pull",
    env: { EULA: "TRUE", TYPE: "NEOFORGE", MEMORY: "10G", CF_FILE_ID: "100" },
    config_s3_prefix: "s3://gs-game-configs/atm10/",
    idle_check: { type: "minecraft_rcon", timeout_min: 10, config: {} },
    snapshot: { generations: 3, weekly_s3_backup: true },
    discord: { start_message: "s", ready_message: "r", stop_message: "x" },
    ...over,
  };
}

describe("applyGameUpdate — non-cost fields (player allowed)", () => {
  it("lets a player update CF_FILE_ID (env merge, other env kept)", () => {
    const next = applyGameUpdate(
      baseGame(),
      { env: { CF_FILE_ID: "200" } },
      "player",
    );
    expect(next.env.CF_FILE_ID).toBe("200");
    expect(next.env.TYPE).toBe("NEOFORGE"); // untouched env key preserved
  });

  it("lets a player update display_name / enabled", () => {
    const next = applyGameUpdate(
      baseGame(),
      { display_name: "ATM10 renamed", enabled: false },
      "player",
    );
    expect(next.display_name).toBe("ATM10 renamed");
    expect(next.enabled).toBe(false);
  });

  it("never lets game_id change", () => {
    const next = applyGameUpdate(
      baseGame(),
      { game_id: "evil" } as Partial<GameDefinition>,
      "admin",
    );
    expect(next.game_id).toBe("atm10");
  });
});

describe("applyGameUpdate — cost fields (player ignored, admin allowed)", () => {
  it("ignores a player's instance_types / ebs / spot changes", () => {
    const next = applyGameUpdate(
      baseGame(),
      {
        instance_types: ["x.huge"],
        ebs_size_gb: 999,
        spot_max_price_jpy_per_hour: 500,
      },
      "player",
    );
    expect(next.instance_types).toEqual(["r7a.large", "r6a.large"]);
    expect(next.ebs_size_gb).toBe(30);
    expect(next.spot_max_price_jpy_per_hour).toBe(12);
  });

  it("ignores a player's env.MEMORY change but keeps their non-cost env change", () => {
    const next = applyGameUpdate(
      baseGame(),
      { env: { MEMORY: "64G", CF_FILE_ID: "200" } },
      "player",
    );
    expect(next.env.MEMORY).toBe("10G"); // reverted
    expect(next.env.CF_FILE_ID).toBe("200"); // allowed
  });

  it("drops a player-introduced MEMORY when the game had none", () => {
    const game = baseGame({ env: { EULA: "TRUE" } });
    const next = applyGameUpdate(game, { env: { MEMORY: "64G" } }, "player");
    expect(next.env.MEMORY).toBeUndefined();
  });

  it("lets an admin update cost fields", () => {
    const next = applyGameUpdate(
      baseGame(),
      {
        instance_types: ["m7a.xlarge"],
        ebs_size_gb: 50,
        spot_max_price_jpy_per_hour: 20,
        env: { MEMORY: "16G" },
      },
      "admin",
    );
    expect(next.instance_types).toEqual(["m7a.xlarge"]);
    expect(next.ebs_size_gb).toBe(50);
    expect(next.spot_max_price_jpy_per_hour).toBe(20);
    expect(next.env.MEMORY).toBe("16G");
  });
});
