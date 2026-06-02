import { describe, expect, it } from "vitest";

import { deriveModpackMeta } from "./modpack-types.js";

describe("deriveModpackMeta", () => {
  it("extracts the MC version and loader from CF gameVersions", () => {
    expect(deriveModpackMeta(["1.21.1", "NeoForge"])).toEqual({
      minecraftVersion: "1.21.1",
      modLoader: "NEOFORGE",
    });
  });

  it("is order-independent and case-insensitive for the loader", () => {
    expect(deriveModpackMeta(["Forge", "1.20.1"])).toEqual({
      minecraftVersion: "1.20.1",
      modLoader: "FORGE",
    });
  });

  it("maps each known loader name", () => {
    expect(deriveModpackMeta(["Fabric"]).modLoader).toBe("FABRIC");
    expect(deriveModpackMeta(["Quilt"]).modLoader).toBe("QUILT");
  });

  it("takes the first MC version and ignores extra tags", () => {
    const r = deriveModpackMeta(["1.21.1", "Client", "NeoForge", "1.21"]);
    expect(r.minecraftVersion).toBe("1.21.1");
    expect(r.modLoader).toBe("NEOFORGE");
  });

  it("returns null for anything it cannot infer", () => {
    expect(deriveModpackMeta(["Client", "Server"])).toEqual({
      minecraftVersion: null,
      modLoader: null,
    });
    expect(deriveModpackMeta([])).toEqual({
      minecraftVersion: null,
      modLoader: null,
    });
  });
});
