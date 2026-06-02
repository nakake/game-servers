import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleModpacksApi } from "./modpacks.js";
import { SESSION_COOKIE } from "../lib/auth/admin-session.js";
import {
  adminSessionKey,
  type AdminSessionRecord,
} from "@gs/shared/auth-types";
import type { ModpackFile, ModpackSummary } from "../lib/curseforge/types.js";
import type { Env } from "../env.js";

const ctx = {} as ExecutionContext;

// get だけ持つ最小 KV mock (authenticate が session を引くのに使う)。
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

function session(userId = "111"): AdminSessionRecord {
  return {
    user_id: userId,
    issued_at: Date.now() - 1000,
    exp_ts: Date.now() + 120_000,
  };
}

function makeEnv(opts: {
  sessions?: Record<string, AdminSessionRecord>;
  admins?: string;
  players?: string;
}): Env {
  const sessSeed: Record<string, string> = {};
  for (const [sid, s] of Object.entries(opts.sessions ?? {})) {
    sessSeed[adminSessionKey(sid)] = JSON.stringify(s);
  }
  return {
    ADMIN_AUTH: makeKv(sessSeed),
    ADMIN_DISCORD_USER_IDS: opts.admins ?? "",
    PLAYER_DISCORD_USER_IDS: opts.players ?? "",
    CF_API_KEY: "test-key",
  } as unknown as Env;
}

function req(path: string, sid?: string): Request {
  const headers = new Headers();
  if (sid !== undefined) headers.set("cookie", `${SESSION_COOKIE}=${sid}`);
  return new Request(`https://gs-admin.example.com${path}`, { headers });
}

// CF wire レスポンスを URL.pathname でルーティングする fetch mock。
//   - 末尾 /files → listFiles 応答
//   - それ以外    → /v1/mods/search 応答 (searchModpacks / resolveSlug 共用)
function stubCf(opts: {
  search?: unknown[];
  files?: unknown[];
  status?: number;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const u = new URL(input);
      const status = opts.status ?? 200;
      const data = u.pathname.endsWith("/files")
        ? (opts.files ?? [])
        : (opts.search ?? []);
      return new Response(JSON.stringify({ data }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function rawMod(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 999,
    slug: "all-the-mods-10",
    name: "All The Mods 10",
    summary: "kitchen sink modpack",
    logo: { thumbnailUrl: "https://cf.test/logo.png" },
    latestFiles: [rawFile()],
    ...over,
  };
}

function rawFile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    displayName: "ServerFiles-3.10",
    fileName: "ServerFiles-3.10.zip",
    fileDate: "2026-01-01T00:00:00Z",
    releaseType: 1,
    downloadUrl: "https://cf.test/dl/5001",
    gameVersions: ["1.21.1", "NeoForge"],
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("auth gate", () => {
  it("returns 401 without a session cookie", async () => {
    const env = makeEnv({ players: "333" });
    const res = await handleModpacksApi(
      req("/admin/api/modpacks/search?q=atm"),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when the session user is in neither allowlist", async () => {
    const env = makeEnv({
      sessions: { s1: session("999") },
      admins: "111",
      players: "333",
    });
    const res = await handleModpacksApi(
      req("/admin/api/modpacks/search?q=atm", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("rejects non-GET methods with 405", async () => {
    const env = makeEnv({ sessions: { s1: session("333") }, players: "333" });
    const r = new Request(
      "https://gs-admin.example.com/admin/api/modpacks/search?q=atm",
      {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=s1` },
      },
    );
    const res = await handleModpacksApi(r, env, ctx);
    expect(res.status).toBe(405);
  });
});

describe("GET /admin/api/modpacks/search", () => {
  it("returns 400 when q is missing or blank", async () => {
    const env = makeEnv({ sessions: { s1: session("333") }, players: "333" });
    const res = await handleModpacksApi(
      req("/admin/api/modpacks/search", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns normalized modpack summaries", async () => {
    stubCf({ search: [rawMod()] });
    const env = makeEnv({ sessions: { s1: session("333") }, players: "333" });
    const res = await handleModpacksApi(
      req("/admin/api/modpacks/search?q=all+the+mods", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modpacks: ModpackSummary[] };
    expect(body.modpacks).toHaveLength(1);
    expect(body.modpacks[0]).toMatchObject({
      modId: 999,
      slug: "all-the-mods-10",
      name: "All The Mods 10",
      thumbnailUrl: "https://cf.test/logo.png",
    });
  });

  it("passes the keyword to CF as searchFilter", async () => {
    stubCf({ search: [] });
    const env = makeEnv({ sessions: { s1: session("333") }, players: "333" });
    await handleModpacksApi(
      req("/admin/api/modpacks/search?q=create", "s1"),
      env,
      ctx,
    );
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get("searchFilter")).toBe("create");
  });
});

describe("GET /admin/api/modpacks/by-slug/:slug", () => {
  it("returns modpack meta + full version list (2 CF calls)", async () => {
    stubCf({
      search: [rawMod()],
      files: [
        rawFile(),
        rawFile({ id: 5002, displayName: "ServerFiles-3.11" }),
      ],
    });
    const env = makeEnv({ sessions: { s1: session("333") }, players: "333" });
    const res = await handleModpacksApi(
      req("/admin/api/modpacks/by-slug/all-the-mods-10", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modpack: ModpackSummary & { latestFiles?: unknown };
      files: ModpackFile[];
    };
    expect(body.modpack.modId).toBe(999);
    // latestFiles は files に畳まれているので応答には含めない。
    expect(body.modpack.latestFiles).toBeUndefined();
    expect(body.files.map((f) => f.fileId)).toEqual([5001, 5002]);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns 404 when the slug has no exact match", async () => {
    stubCf({ search: [] });
    const env = makeEnv({ sessions: { s1: session("333") }, players: "333" });
    const res = await handleModpacksApi(
      req("/admin/api/modpacks/by-slug/does-not-exist", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("routing + upstream errors", () => {
  it("returns 404 for an unknown modpacks sub-route", async () => {
    const env = makeEnv({ sessions: { s1: session("333") }, players: "333" });
    const res = await handleModpacksApi(
      req("/admin/api/modpacks/bogus", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("maps a CF 5xx to 502", async () => {
    stubCf({ status: 500 });
    const env = makeEnv({ sessions: { s1: session("333") }, players: "333" });
    const res = await handleModpacksApi(
      req("/admin/api/modpacks/search?q=atm", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(502);
  });

  it("surfaces a CF 429 as 429", async () => {
    stubCf({ status: 429 });
    const env = makeEnv({ sessions: { s1: session("333") }, players: "333" });
    const res = await handleModpacksApi(
      req("/admin/api/modpacks/search?q=atm", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(429);
  });
});
