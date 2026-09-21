import { describe, expect, it } from "vitest";

import { parseRegistryIndex } from "./registry-index.js";

describe("parseRegistryIndex", () => {
  it("returns the array as-is when every element is a string", () => {
    expect(parseRegistryIndex(["atm10", "atm11"])).toEqual(["atm10", "atm11"]);
  });

  it("returns undefined for an empty array (0 件は miss 扱い)", () => {
    expect(parseRegistryIndex([])).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(parseRegistryIndex(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(parseRegistryIndex(undefined)).toBeUndefined();
  });

  it("returns undefined for a non-array object", () => {
    expect(parseRegistryIndex({ keys: ["atm10"] })).toBeUndefined();
  });

  it("returns undefined for a string", () => {
    expect(parseRegistryIndex("atm10")).toBeUndefined();
  });

  it("returns undefined when any element is not a string", () => {
    expect(parseRegistryIndex(["a", 1])).toBeUndefined();
  });
});
