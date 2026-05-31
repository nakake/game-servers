import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAuth } from "./auth.js";
import { SESSION_COOKIE } from "../lib/auth/admin-session.js";
import {
  adminSessionKey,
  adminTokenKey,
  type AdminSessionRecord,
  type AdminTokenRecord,
} from "@gs/shared/auth-types";
import type { Env } from "../env.js";

function makeKv(seed: Record<string, string> = {}): {
  kv: KVNamespace;
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(seed));
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function makeEnv(kv: KVNamespace, admins = "111", players = ""): Env {
  return {
    ADMIN_AUTH: kv,
    ADMIN_DISCORD_USER_IDS: admins,
    PLAYER_DISCORD_USER_IDS: players,
  } as unknown as Env;
}

const ctx = {} as ExecutionContext;

function validToken(userId = "111"): AdminTokenRecord {
  return {
    user_id: userId,
    issued_at: Date.now() - 1000,
    exp_ts: Date.now() + 120_000,
    used: false,
  };
}

function session(userId = "111"): AdminSessionRecord {
  return {
    user_id: userId,
    issued_at: Date.now() - 1000,
    exp_ts: Date.now() + 120_000,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /auth (magic link landing)", () => {
  it("consumes a valid token, sets a session cookie, and serves the redirect HTML", async () => {
    const { kv } = makeKv({
      [adminTokenKey("tok")]: JSON.stringify(validToken()),
    });
    const req = new Request("https://gs-admin.example.com/auth?t=tok");
    const res = await handleAuth(req, makeEnv(kv), ctx);

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");

    const html = await res.text();
    expect(html).toContain("history.replaceState");
    // CSP nonce が script と一致していること。
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonceInCsp = /nonce-([A-Za-z0-9_-]+)/.exec(csp)?.[1];
    expect(nonceInCsp).toBeTruthy();
    expect(html).toContain(`nonce="${nonceInCsp}"`);
  });

  it("rejects an invalid/expired token with 401 and no cookie", async () => {
    const { kv } = makeKv();
    const req = new Request("https://gs-admin.example.com/auth?t=bad");
    const res = await handleAuth(req, makeEnv(kv), ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects with 403 (no session) when the user is in neither allowlist", async () => {
    const { kv, store } = makeKv({
      [adminTokenKey("tok")]: JSON.stringify(validToken("999")),
    });
    const req = new Request("https://gs-admin.example.com/auth?t=tok");
    const res = await handleAuth(req, makeEnv(kv, "111", "222"), ctx);

    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    // session が作られていないこと。
    const sessionKeys = [...store.keys()].filter((k) =>
      k.startsWith("admin_session:"),
    );
    expect(sessionKeys).toHaveLength(0);
  });

  it("never logs the raw token", async () => {
    const { kv } = makeKv({
      [adminTokenKey("secret-tok")]: JSON.stringify(validToken()),
    });
    const req = new Request("https://gs-admin.example.com/auth?t=secret-tok");
    await handleAuth(req, makeEnv(kv), ctx);

    const logged = (
      console.log as unknown as ReturnType<typeof vi.fn>
    ).mock.calls
      .flat()
      .map((a) => JSON.stringify(a))
      .join(" ");
    expect(logged).not.toContain("secret-tok");
  });
});

describe("POST /admin/api/auth/logout", () => {
  it("deletes the session and clears the cookie", async () => {
    const { kv, store } = makeKv({
      [adminSessionKey("s1")]: JSON.stringify(session()),
    });
    const req = new Request(
      "https://gs-admin.example.com/admin/api/auth/logout",
      {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=s1`,
          "x-requested-with": "fetch",
        },
      },
    );
    const res = await handleAuth(req, makeEnv(kv), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(store.has(adminSessionKey("s1"))).toBe(false);
  });

  it("rejects logout without X-Requested-With (CSRF guard)", async () => {
    const { kv } = makeKv({
      [adminSessionKey("s1")]: JSON.stringify(session()),
    });
    const req = new Request(
      "https://gs-admin.example.com/admin/api/auth/logout",
      {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=s1` },
      },
    );
    const res = await handleAuth(req, makeEnv(kv), ctx);
    expect(res.status).toBe(403);
  });

  it("rejects GET on the logout route (405)", async () => {
    const { kv } = makeKv();
    const req = new Request(
      "https://gs-admin.example.com/admin/api/auth/logout",
      {
        method: "GET",
      },
    );
    const res = await handleAuth(req, makeEnv(kv), ctx);
    expect(res.status).toBe(405);
  });
});
