import { describe, expect, it } from "vitest";

import {
  adminSessionKey,
  adminTokenKey,
  deriveTier,
  generateOpaqueToken,
  parseAllowlist,
} from "./auth-types.js";

describe("parseAllowlist", () => {
  it("returns empty set for undefined / empty string", () => {
    expect(parseAllowlist(undefined).size).toBe(0);
    expect(parseAllowlist("").size).toBe(0);
  });

  it("splits CSV, trims whitespace, drops empties", () => {
    const set = parseAllowlist(" 111 , 222,, 333 ");
    expect([...set].sort()).toEqual(["111", "222", "333"]);
  });
});

describe("deriveTier (fail-closed, admin precedence)", () => {
  const ADMINS = "111,222";
  const PLAYERS = "333,444";

  it("returns admin when in admin list", () => {
    expect(deriveTier("111", ADMINS, PLAYERS)).toBe("admin");
  });

  it("returns player when in player list only", () => {
    expect(deriveTier("333", ADMINS, PLAYERS)).toBe("player");
  });

  it("prefers admin when present in both lists", () => {
    expect(deriveTier("555", "555", "555")).toBe("admin");
  });

  it("returns null when in neither list (fail-closed)", () => {
    expect(deriveTier("999", ADMINS, PLAYERS)).toBeNull();
  });

  it("returns null for empty userId", () => {
    expect(deriveTier("", ADMINS, PLAYERS)).toBeNull();
  });

  it("returns null when both allowlists are empty/undefined", () => {
    expect(deriveTier("111", undefined, undefined)).toBeNull();
    expect(deriveTier("111", "", "")).toBeNull();
  });

  it("tolerates whitespace around ids in the CSV", () => {
    expect(deriveTier("222", " 111 , 222 ", PLAYERS)).toBe("admin");
  });
});

describe("KV key helpers", () => {
  it("prefixes token and session keys", () => {
    expect(adminTokenKey("abc")).toBe("admin_token:abc");
    expect(adminSessionKey("xyz")).toBe("admin_session:xyz");
  });
});

describe("generateOpaqueToken", () => {
  it("produces a url-safe base64 string (no + / =)", () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is long enough to be unguessable (32 bytes → >=43 chars)", () => {
    expect(generateOpaqueToken().length).toBeGreaterThanOrEqual(43);
  });

  it("honors a custom byte length (16 bytes → >=22 chars)", () => {
    expect(generateOpaqueToken(16).length).toBeGreaterThanOrEqual(22);
  });

  it("produces distinct values across calls", () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
  });
});
