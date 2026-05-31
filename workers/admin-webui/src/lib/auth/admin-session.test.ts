import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticate,
  clearSessionCookie,
  consumeAdminToken,
  createSession,
  destroySession,
  getSessionRecord,
  readSessionId,
  sessionCookie,
  SESSION_COOKIE,
} from "./admin-session.js";
import {
  adminSessionKey,
  adminTokenKey,
  type AdminSessionRecord,
  type AdminTokenRecord,
} from "@gs/shared/auth-types";
import type { Env } from "../../env.js";

// in-memory KV mock。
function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace;
}

const NOW = 1_700_000_000_000;

function tokenRecord(over: Partial<AdminTokenRecord> = {}): AdminTokenRecord {
  return {
    user_id: "111",
    issued_at: NOW - 1000,
    exp_ts: NOW + 60_000,
    used: false,
    ...over,
  };
}

function sessionRecord(
  over: Partial<AdminSessionRecord> = {},
): AdminSessionRecord {
  return {
    user_id: "111",
    issued_at: NOW - 1000,
    exp_ts: NOW + 60_000,
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumeAdminToken (one-shot)", () => {
  it("returns user_id for a valid unused token and marks it used", async () => {
    const key = adminTokenKey("tok");
    const kv = makeKv({ [key]: JSON.stringify(tokenRecord()) });

    const first = await consumeAdminToken(kv, "tok", NOW);
    expect(first).toEqual({ user_id: "111" });

    // 2 回目は used=true なので reject (one-shot)。
    const second = await consumeAdminToken(kv, "tok", NOW);
    expect(second).toBeNull();
  });

  it("rejects an expired token", async () => {
    const key = adminTokenKey("tok");
    const kv = makeKv({
      [key]: JSON.stringify(tokenRecord({ exp_ts: NOW - 1 })),
    });
    expect(await consumeAdminToken(kv, "tok", NOW)).toBeNull();
  });

  it("rejects a missing token", async () => {
    expect(await consumeAdminToken(makeKv(), "nope", NOW)).toBeNull();
  });

  it("rejects null/empty token without touching KV", async () => {
    const kv = makeKv();
    const spy = vi.spyOn(kv, "get");
    expect(await consumeAdminToken(kv, null, NOW)).toBeNull();
    expect(await consumeAdminToken(kv, "", NOW)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a corrupt JSON record", async () => {
    const kv = makeKv({ [adminTokenKey("tok")]: "not-json" });
    expect(await consumeAdminToken(kv, "tok", NOW)).toBeNull();
  });
});

describe("createSession / getSessionRecord", () => {
  it("creates a retrievable session and returns a cookie", async () => {
    const kv = makeKv();
    const { sid, cookie } = await createSession(kv, "222", NOW);
    expect(sid).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cookie).toContain(`${SESSION_COOKIE}=${sid}`);

    const record = await getSessionRecord(kv, sid, NOW);
    expect(record?.user_id).toBe("222");
  });

  it("returns null for an expired session", async () => {
    const kv = makeKv({
      [adminSessionKey("sid")]: JSON.stringify(
        sessionRecord({ exp_ts: NOW - 1 }),
      ),
    });
    expect(await getSessionRecord(kv, "sid", NOW)).toBeNull();
  });

  it("returns null for a missing session", async () => {
    expect(await getSessionRecord(makeKv(), "sid", NOW)).toBeNull();
  });
});

describe("authenticate (re-derives tier each request)", () => {
  function envWith(admins: string, players: string, kv: KVNamespace): Env {
    return {
      ADMIN_DISCORD_USER_IDS: admins,
      PLAYER_DISCORD_USER_IDS: players,
      ADMIN_AUTH: kv,
    } as unknown as Env;
  }

  function reqWithSid(sid: string): Request {
    return new Request("https://gs-admin.example.com/admin/api/games", {
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
  }

  it("returns admin tier for a session whose user is in the admin allowlist", async () => {
    const kv = makeKv({
      [adminSessionKey("s1")]: JSON.stringify(
        sessionRecord({ user_id: "111" }),
      ),
    });
    const result = await authenticate(
      envWith("111", "", kv),
      reqWithSid("s1"),
      NOW,
    );
    expect(result).toEqual({ userId: "111", tier: "admin" });
  });

  it("returns player tier when only in the player allowlist", async () => {
    const kv = makeKv({
      [adminSessionKey("s1")]: JSON.stringify(
        sessionRecord({ user_id: "333" }),
      ),
    });
    const result = await authenticate(
      envWith("111", "333", kv),
      reqWithSid("s1"),
      NOW,
    );
    expect(result).toEqual({ userId: "333", tier: "player" });
  });

  it("returns null when the session user was removed from both allowlists", async () => {
    const kv = makeKv({
      [adminSessionKey("s1")]: JSON.stringify(
        sessionRecord({ user_id: "999" }),
      ),
    });
    const result = await authenticate(
      envWith("111", "333", kv),
      reqWithSid("s1"),
      NOW,
    );
    expect(result).toBeNull();
  });

  it("returns null when there is no session cookie", async () => {
    const kv = makeKv();
    const req = new Request("https://gs-admin.example.com/admin/api/games");
    expect(await authenticate(envWith("111", "", kv), req, NOW)).toBeNull();
  });
});

describe("destroySession", () => {
  it("deletes the session so it no longer authenticates", async () => {
    const kv = makeKv({
      [adminSessionKey("s1")]: JSON.stringify(sessionRecord()),
    });
    await destroySession(kv, "s1");
    expect(await getSessionRecord(kv, "s1", NOW)).toBeNull();
  });
});

describe("cookie helpers", () => {
  it("sessionCookie sets Secure; HttpOnly; SameSite=Strict; Path=/", () => {
    const c = sessionCookie("abc");
    expect(c).toContain("Secure");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=86400");
  });

  it("clearSessionCookie expires the cookie (Max-Age=0)", () => {
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  it("readSessionId extracts the cookie value among others", () => {
    expect(readSessionId(`foo=1; ${SESSION_COOKIE}=xyz; bar=2`)).toBe("xyz");
    expect(readSessionId("foo=1; bar=2")).toBeNull();
    expect(readSessionId(null)).toBeNull();
  });
});
