import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleGamesApi } from "./games.js";
import { SESSION_COOKIE } from "../lib/auth/admin-session.js";
import {
  adminSessionKey,
  type AdminSessionRecord,
} from "@gs/shared/auth-types";
import type { GameDefinition } from "@gs/shared/registry-types";
import type { Env } from "../env.js";

const ctx = {} as ExecutionContext;

// in-memory KV mock with list() support.
function makeKv(seed: Record<string, string> = {}): {
  kv: KVNamespace;
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(seed));
  const kv = {
    get: async (k: string, type?: "json") => {
      const raw = store.get(k);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
  return { kv, store };
}

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

function session(userId = "111"): AdminSessionRecord {
  return {
    user_id: userId,
    issued_at: Date.now() - 1000,
    exp_ts: Date.now() + 120_000,
  };
}

// GAME_REGISTRY と ADMIN_AUTH を別 KV にして Env を組む。
function makeEnv(opts: {
  games?: Record<string, GameDefinition>;
  sessions?: Record<string, AdminSessionRecord>;
  admins?: string;
  players?: string;
  // DISCORD_HANDLER RPC stub の差し替え (ops endpoint 用)。省略時は全メソッド ok:true。
  rpc?: Partial<Env["DISCORD_HANDLER"]>;
}): { env: Env; gamesStore: Map<string, string> } {
  const gameSeed: Record<string, string> = {};
  for (const [id, g] of Object.entries(opts.games ?? {})) {
    gameSeed[id] = JSON.stringify(g);
  }
  const sessSeed: Record<string, string> = {};
  for (const [sid, s] of Object.entries(opts.sessions ?? {})) {
    sessSeed[adminSessionKey(sid)] = JSON.stringify(s);
  }
  const games = makeKv(gameSeed);
  const auth = makeKv(sessSeed);
  const rpc: Env["DISCORD_HANDLER"] = {
    start: async (id: string) => ({
      ok: true,
      game_id: id,
      instance_id: "i-1",
    }),
    stop: async (id: string) => ({ ok: true, game_id: id }),
    status: async (id: string) => ({ game_id: id, state: "running" as const }),
    ...opts.rpc,
  };
  const env = {
    GAME_REGISTRY: games.kv,
    ADMIN_AUTH: auth.kv,
    ADMIN_DISCORD_USER_IDS: opts.admins ?? "",
    PLAYER_DISCORD_USER_IDS: opts.players ?? "",
    CLOUDFLARE_DNS_API_TOKEN: "cf-token",
    CLOUDFLARE_ZONE_ID: "zone-1",
    CLOUDFLARE_BASE_DOMAIN: "nakake.com",
    DISCORD_HANDLER: rpc,
  } as unknown as Env;
  return { env, gamesStore: games.store };
}

function req(path: string, init: RequestInit & { sid?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.sid !== undefined) {
    headers.set("cookie", `${SESSION_COOKIE}=${init.sid}`);
  }
  return new Request(`https://gs-admin.example.com${path}`, {
    ...init,
    headers,
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Cloudflare DNS の fetch をモックする。GET dns_records → 既存検索、POST → 作成。
//   existingId !== null なら GET が 1 件返し、create は呼ばれない (冪等パス)。
function stubDns(
  opts: { existingId?: string | null; createId?: string } = {},
): void {
  const existingId = opts.existingId ?? null;
  const createId = opts.createId ?? "rec-new";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body =
        method === "GET"
          ? { success: true, result: existingId ? [{ id: existingId }] : [] }
          : { success: true, result: { id: createId } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function newGameBody(
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

function postReq(sid: string, body: unknown, xrw = true): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (xrw) headers["x-requested-with"] = "fetch";
  return req("/admin/api/games", {
    method: "POST",
    sid,
    headers,
    body: JSON.stringify(body),
  });
}

describe("auth gate", () => {
  it("returns 401 without a session cookie", async () => {
    const { env } = makeEnv({ games: { atm10: baseGame() }, admins: "111" });
    const res = await handleGamesApi(req("/admin/api/games"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the session user is in neither allowlist", async () => {
    const { env } = makeEnv({
      games: { atm10: baseGame() },
      sessions: { s1: session("999") },
      admins: "111",
      players: "222",
    });
    const res = await handleGamesApi(
      req("/admin/api/games", { sid: "s1" }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/api/games (list)", () => {
  it("returns all games for an authenticated player", async () => {
    const { env } = makeEnv({
      games: { atm10: baseGame(), atm11: baseGame({ game_id: "atm11" }) },
      sessions: { s1: session("333") },
      players: "333",
    });
    const res = await handleGamesApi(
      req("/admin/api/games", { sid: "s1" }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { games: GameDefinition[] };
    expect(body.games.map((g) => g.game_id).sort()).toEqual(["atm10", "atm11"]);
  });
});

describe("GET /admin/api/games/:id", () => {
  it("returns a single game", async () => {
    const { env } = makeEnv({
      games: { atm10: baseGame() },
      sessions: { s1: session("333") },
      players: "333",
    });
    const res = await handleGamesApi(
      req("/admin/api/games/atm10", { sid: "s1" }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { game: GameDefinition };
    expect(body.game.game_id).toBe("atm10");
  });

  it("returns 404 for an unknown game", async () => {
    const { env } = makeEnv({
      games: { atm10: baseGame() },
      sessions: { s1: session("333") },
      players: "333",
    });
    const res = await handleGamesApi(
      req("/admin/api/games/nope", { sid: "s1" }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("PUT /admin/api/games/:id", () => {
  function putReq(id: string, sid: string, body: unknown, xrw = true): Request {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (xrw) headers["x-requested-with"] = "fetch";
    return req(`/admin/api/games/${id}`, {
      method: "PUT",
      sid,
      headers,
      body: JSON.stringify(body),
    });
  }

  it("requires X-Requested-With", async () => {
    const { env } = makeEnv({
      games: { atm10: baseGame() },
      sessions: { s1: session("333") },
      players: "333",
    });
    const res = await handleGamesApi(
      putReq("atm10", "s1", { display_name: "x" }, false),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("lets a player change CF_FILE_ID and persists it to KV", async () => {
    const { env, gamesStore } = makeEnv({
      games: { atm10: baseGame() },
      sessions: { s1: session("333") },
      players: "333",
    });
    const res = await handleGamesApi(
      putReq("atm10", "s1", { env: { CF_FILE_ID: "200" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const persisted = JSON.parse(gamesStore.get("atm10")!) as GameDefinition;
    expect(persisted.env.CF_FILE_ID).toBe("200");
    expect(persisted.env.TYPE).toBe("NEOFORGE");
  });

  it("ignores a player's cost-field changes (enforcement)", async () => {
    const { env, gamesStore } = makeEnv({
      games: { atm10: baseGame() },
      sessions: { s1: session("333") },
      players: "333",
    });
    await handleGamesApi(
      putReq("atm10", "s1", {
        instance_types: ["x.huge"],
        ebs_size_gb: 999,
        env: { MEMORY: "64G" },
      }),
      env,
      ctx,
    );
    const persisted = JSON.parse(gamesStore.get("atm10")!) as GameDefinition;
    expect(persisted.instance_types).toEqual(["r7a.large", "r6a.large"]);
    expect(persisted.ebs_size_gb).toBe(30);
    expect(persisted.env.MEMORY).toBe("10G");
  });

  it("lets an admin change cost fields", async () => {
    const { env, gamesStore } = makeEnv({
      games: { atm10: baseGame() },
      sessions: { s1: session("111") },
      admins: "111",
    });
    const res = await handleGamesApi(
      putReq("atm10", "s1", { ebs_size_gb: 50, env: { MEMORY: "16G" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const persisted = JSON.parse(gamesStore.get("atm10")!) as GameDefinition;
    expect(persisted.ebs_size_gb).toBe(50);
    expect(persisted.env.MEMORY).toBe("16G");
  });

  it("returns 404 when updating an unknown game", async () => {
    const { env } = makeEnv({
      games: { atm10: baseGame() },
      sessions: { s1: session("111") },
      admins: "111",
    });
    const res = await handleGamesApi(
      putReq("nope", "s1", { display_name: "x" }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 on invalid JSON", async () => {
    const { env } = makeEnv({
      games: { atm10: baseGame() },
      sessions: { s1: session("111") },
      admins: "111",
    });
    const r = req("/admin/api/games/atm10", {
      method: "PUT",
      sid: "s1",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "fetch",
      },
      body: "{not json",
    });
    const res = await handleGamesApi(r, env, ctx);
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/api/games (new game)", () => {
  it("requires X-Requested-With", async () => {
    const { env } = makeEnv({
      sessions: { s1: session("111") },
      admins: "111",
    });
    const res = await handleGamesApi(
      postReq("s1", newGameBody(), false),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("creates a game: DNS A record + KV put, returns 201", async () => {
    stubDns({ existingId: null, createId: "rec-new" });
    const { env, gamesStore } = makeEnv({
      sessions: { s1: session("111") },
      admins: "111",
    });
    const res = await handleGamesApi(postReq("s1", newGameBody()), env, ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { game: GameDefinition };
    expect(body.game.game_id).toBe("atm9");
    expect(body.game.cf_record_id).toBe("rec-new");
    expect(body.game.env.MODPACK_PLATFORM).toBe("AUTO_CURSEFORGE");
    // persisted under the bare game_id key.
    const persisted = JSON.parse(gamesStore.get("atm9")!) as GameDefinition;
    expect(persisted.subdomain).toBe("atm9");
    // DNS was contacted: GET (find) + POST (create) = 2 calls.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses an existing DNS record (idempotent, no create call)", async () => {
    stubDns({ existingId: "rec-old" });
    const { env } = makeEnv({
      sessions: { s1: session("111") },
      admins: "111",
    });
    const res = await handleGamesApi(postReq("s1", newGameBody()), env, ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { game: GameDefinition };
    expect(body.game.cf_record_id).toBe("rec-old");
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1); // GET only, no POST
  });

  it("returns 409 when the game_id already exists", async () => {
    stubDns();
    const { env } = makeEnv({
      games: { atm9: baseGame({ game_id: "atm9" }) },
      sessions: { s1: session("111") },
      admins: "111",
    });
    const res = await handleGamesApi(postReq("s1", newGameBody()), env, ctx);
    expect(res.status).toBe(409);
    // no DNS call when the conflict is detected first.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns 400 on an invalid form (bad game_id)", async () => {
    const { env } = makeEnv({
      sessions: { s1: session("111") },
      admins: "111",
    });
    const res = await handleGamesApi(
      postReq("s1", newGameBody({ game_id: "Bad_Id" })),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("forces cost defaults for a player creating a game", async () => {
    stubDns();
    const { env, gamesStore } = makeEnv({
      sessions: { s1: session("333") },
      players: "333",
    });
    const res = await handleGamesApi(
      postReq("s1", newGameBody({ ebs_size_gb: 999, memory_gb: 64 })),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    const persisted = JSON.parse(gamesStore.get("atm9")!) as GameDefinition;
    expect(persisted.ebs_size_gb).toBe(30); // COST_FIELD_DEFAULTS
    expect(persisted.env.MEMORY).toBe("8G");
  });

  it("returns 502 when the Cloudflare DNS API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1004, message: "bad" }],
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const { env } = makeEnv({
      sessions: { s1: session("111") },
      admins: "111",
    });
    const res = await handleGamesApi(postReq("s1", newGameBody()), env, ctx);
    expect(res.status).toBe(502);
  });
});

describe("ops endpoints (start/stop/status RPC)", () => {
  function opsReq(
    id: string,
    sub: string,
    method: "POST" | "GET",
    sid: string,
    xrw = true,
  ): Request {
    const headers: Record<string, string> = {};
    if (xrw) headers["x-requested-with"] = "fetch";
    return req(`/admin/api/games/${id}/${sub}`, { method, sid, headers });
  }

  it("POST start delegates to the RPC and returns the result", async () => {
    let called: string | null = null;
    const { env } = makeEnv({
      sessions: { s1: session("111") },
      admins: "111",
      rpc: {
        start: async (id: string) => {
          called = id;
          return { ok: true, game_id: id, instance_id: "i-42" };
        },
      },
    });
    const res = await handleGamesApi(
      opsReq("atm10", "start", "POST", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(202); // accepted (RPC backgrounds the workflow)
    expect(called).toBe("atm10");
    const body = (await res.json()) as { result: { instance_id: string } };
    expect(body.result.instance_id).toBe("i-42");
  });

  it("POST start requires X-Requested-With", async () => {
    const { env } = makeEnv({
      sessions: { s1: session("111") },
      admins: "111",
    });
    const res = await handleGamesApi(
      opsReq("atm10", "start", "POST", "s1", false),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("maps an RPC ok:false (rejected) result to 409", async () => {
    const { env } = makeEnv({
      sessions: { s1: session("111") },
      admins: "111",
      rpc: {
        start: async (id: string) => ({
          ok: false,
          game_id: id,
          message: "disabled",
        }),
      },
    });
    const res = await handleGamesApi(
      opsReq("atm10", "start", "POST", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(409);
  });

  it("returns 502 when the RPC itself throws", async () => {
    const { env } = makeEnv({
      sessions: { s1: session("111") },
      admins: "111",
      rpc: {
        stop: async () => {
          throw new Error("binding down");
        },
      },
    });
    const res = await handleGamesApi(
      opsReq("atm10", "stop", "POST", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(502);
  });

  it("GET status delegates and returns the state", async () => {
    const { env } = makeEnv({
      sessions: { s1: session("333") },
      players: "333",
      rpc: {
        status: async (id: string) => ({
          game_id: id,
          state: "running" as const,
          endpoint: "atm10.nakake.com:25565",
        }),
      },
    });
    const res = await handleGamesApi(
      opsReq("atm10", "status", "GET", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { state: string } };
    expect(body.result.state).toBe("running");
  });

  it("rejects status via POST with 405", async () => {
    const { env } = makeEnv({
      sessions: { s1: session("111") },
      admins: "111",
    });
    const res = await handleGamesApi(
      opsReq("atm10", "status", "POST", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(405);
  });

  it("returns 404 for an unknown op", async () => {
    const { env } = makeEnv({
      sessions: { s1: session("111") },
      admins: "111",
    });
    const res = await handleGamesApi(
      opsReq("atm10", "frobnicate", "POST", "s1"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("still gates ops behind auth (401 without session)", async () => {
    const { env } = makeEnv({ admins: "111" });
    const res = await handleGamesApi(
      req("/admin/api/games/atm10/start", { method: "POST" }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });
});
