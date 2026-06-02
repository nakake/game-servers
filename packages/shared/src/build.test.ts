import { describe, expect, it } from "vitest";

import {
  COST_FIELD_DEFAULTS,
  applyGameUpdate,
  buildGameDefinition,
  resolveCostFields,
  validateNewGameForm,
  type ValidatedNewGameForm,
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

// ---- D-2: validateNewGameForm ----

function validBody(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    game_id: "atm9",
    display_name: "All The Mods 9",
    cf_slug: "all-the-mods-9",
    cf_modpack_meta: {
      modId: 426988,
      minecraftVersion: "1.20.1",
      modLoader: "FORGE",
    },
    ...over,
  };
}

describe("validateNewGameForm", () => {
  it("accepts a minimal valid body and defaults subdomain/port", () => {
    const r = validateNewGameForm(validBody());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.subdomain).toBe("atm9"); // defaults to game_id
    expect(r.value.port).toBe(25565);
    expect(r.value.cf_file_id).toBeUndefined();
  });

  it.each([
    ["Atm9", "uppercase"],
    ["-atm9", "leading dash"],
    ["9atm", "leading digit"],
    ["atm_9", "underscore"],
  ])("rejects game_id %s (%s)", (game_id) => {
    const r = validateNewGameForm(validBody({ game_id }));
    expect(r.ok).toBe(false);
  });

  it("rejects a missing display_name", () => {
    const r = validateNewGameForm(validBody({ display_name: "   " }));
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown modLoader", () => {
    const r = validateNewGameForm(
      validBody({
        cf_modpack_meta: {
          modId: 1,
          minecraftVersion: "1.20.1",
          modLoader: "BUKKIT",
        },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a non-integer modId", () => {
    const r = validateNewGameForm(
      validBody({
        cf_modpack_meta: {
          modId: "x",
          minecraftVersion: "1.20.1",
          modLoader: "FORGE",
        },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an out-of-range port", () => {
    expect(validateNewGameForm(validBody({ port: 70000 })).ok).toBe(false);
    expect(validateNewGameForm(validBody({ port: 0 })).ok).toBe(false);
  });

  it("keeps cf_file_id and cost fields when provided", () => {
    const r = validateNewGameForm(
      validBody({
        cf_file_id: 5001,
        memory_gb: 12,
        instance_types: ["r7a.xlarge"],
        ebs_size_gb: 40,
        spot_max_price_jpy_per_hour: null,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cf_file_id).toBe(5001);
    expect(r.value.memory_gb).toBe(12);
    expect(r.value.spot_max_price_jpy_per_hour).toBeNull();
  });

  it("rejects a non-object body", () => {
    expect(validateNewGameForm(null).ok).toBe(false);
    expect(validateNewGameForm([]).ok).toBe(false);
    expect(validateNewGameForm("x").ok).toBe(false);
  });
});

// ---- D-2: buildGameDefinition ----

function form(over: Partial<ValidatedNewGameForm> = {}): ValidatedNewGameForm {
  return {
    game_id: "atm9",
    display_name: "All The Mods 9",
    subdomain: "atm9",
    cf_slug: "all-the-mods-9",
    cf_modpack_meta: {
      modId: 426988,
      minecraftVersion: "1.20.1",
      modLoader: "FORGE",
    },
    port: 25565,
    ...over,
  };
}

describe("buildGameDefinition", () => {
  it("produces an AUTO_CURSEFORGE modded game wired to the slug/version/loader", () => {
    const g = buildGameDefinition(form(), "admin", "rec-xyz");
    expect(g.game_id).toBe("atm9");
    expect(g.category).toBe("minecraft-modded");
    expect(g.enabled).toBe(true);
    expect(g.cf_record_id).toBe("rec-xyz");
    expect(g.env.MODPACK_PLATFORM).toBe("AUTO_CURSEFORGE");
    expect(g.env.CF_SLUG).toBe("all-the-mods-9");
    expect(g.env.TYPE).toBe("FORGE");
    expect(g.env.VERSION).toBe("1.20.1");
    expect(g.env.CF_API_KEY_FROM_SSM).toBe("/gs/global/cf_api_key");
    expect(g.env.RCON_PASSWORD_FROM_SSM).toBe("/gs/atm9/rcon_password");
    expect(g.config_s3_prefix).toBe("s3://gs-game-configs/atm9/");
    expect(g.ports).toEqual([{ port: 25565, proto: "TCP" }]);
    expect(g.snapshot.tags?.Game).toBe("atm9");
  });

  it("omits CF_FILE_ID when no cf_file_id, includes it when set", () => {
    expect(
      buildGameDefinition(form(), "admin", "r").env.CF_FILE_ID,
    ).toBeUndefined();
    expect(
      buildGameDefinition(form({ cf_file_id: 5001 }), "admin", "r").env
        .CF_FILE_ID,
    ).toBe("5001");
  });

  it("forces cost defaults for a player even if cost fields were supplied", () => {
    const g = buildGameDefinition(
      form({
        memory_gb: 64,
        instance_types: ["x.huge"],
        ebs_size_gb: 999,
        spot_max_price_jpy_per_hour: 5,
      }),
      "player",
      "r",
    );
    expect(g.instance_types).toEqual(COST_FIELD_DEFAULTS.instance_types);
    expect(g.ebs_size_gb).toBe(COST_FIELD_DEFAULTS.ebs_size_gb);
    expect(g.env.MEMORY).toBe(`${COST_FIELD_DEFAULTS.memory_gb}G`);
  });

  it("applies admin-provided cost fields", () => {
    const g = buildGameDefinition(
      form({ memory_gb: 12, ebs_size_gb: 40 }),
      "admin",
      "r",
    );
    expect(g.ebs_size_gb).toBe(40);
    expect(g.env.MEMORY).toBe("12G");
  });
});
