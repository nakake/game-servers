import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handlePanelCommand } from "./panel.js";
import { ADMIN_TOKEN_PREFIX } from "@gs/shared/auth-types";
import type { Interaction } from "../../lib/discord/types.js";
import type { Env } from "../../env.js";

interface PutCall {
  key: string;
  value: string;
  opts?: { expirationTtl?: number } | undefined;
}

// put 呼び出しを記録する in-memory KV mock。
function makeKv(): {
  kv: KVNamespace;
  puts: PutCall[];
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const puts: PutCall[] = [];
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      store.set(k, v);
      puts.push({ key: k, value: v, opts });
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace;
  return { kv, puts, store };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_BASE_URL: "https://gs-admin.example.com",
    ...overrides,
  } as unknown as Env;
}

function guildInteraction(userId = "12345"): Interaction {
  return {
    id: "i1",
    application_id: "app1",
    token: "itok",
    type: 2,
    data: { id: "c1", name: "panel", type: 1 },
    guild_id: "g1",
    member: { user: { id: userId, username: "tester" } },
  };
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handlePanelCommand", () => {
  it("responds EPHEMERAL (flags: 64) — load-bearing for token secrecy (§9.1 #1)", async () => {
    const { kv } = makeKv();
    const res = await handlePanelCommand(
      guildInteraction(),
      makeEnv({ ADMIN_AUTH: kv }),
    );
    const body = await bodyOf(res);
    expect(body.type).toBe(4);
    expect((body.data as { flags: number }).flags).toBe(64);
  });

  it("stores a one-shot token in ADMIN_AUTH with 300s TTL", async () => {
    const { kv, puts } = makeKv();
    await handlePanelCommand(
      guildInteraction("777"),
      makeEnv({ ADMIN_AUTH: kv }),
    );

    expect(puts).toHaveLength(1);
    const put = puts[0]!;
    expect(put.key.startsWith(ADMIN_TOKEN_PREFIX)).toBe(true);
    expect(put.opts?.expirationTtl).toBe(300);

    const record = JSON.parse(put.value) as {
      user_id: string;
      used: boolean;
      exp_ts: number;
      issued_at: number;
    };
    expect(record.user_id).toBe("777");
    expect(record.used).toBe(false);
    expect(record.exp_ts).toBeGreaterThan(record.issued_at);
  });

  it("puts the same token into the button URL as the KV key", async () => {
    const { kv, puts } = makeKv();
    const res = await handlePanelCommand(
      guildInteraction(),
      makeEnv({ ADMIN_AUTH: kv }),
    );
    const body = await bodyOf(res);
    const url = (
      body.data as { components: { components: { url: string }[] }[] }
    ).components[0]!.components[0]!.url;

    const tokenInKey = puts[0]!.key.slice(ADMIN_TOKEN_PREFIX.length);
    expect(url).toBe(`https://gs-admin.example.com/auth?t=${tokenInKey}`);
    // link button (style 5)。
    const button = (
      body.data as { components: { components: { style: number }[] }[] }
    ).components[0]!.components[0]!;
    expect(button.style).toBe(5);
  });

  it("strips a trailing slash from ADMIN_BASE_URL", async () => {
    const { kv } = makeKv();
    const res = await handlePanelCommand(
      guildInteraction(),
      makeEnv({
        ADMIN_AUTH: kv,
        ADMIN_BASE_URL: "https://gs-admin.example.com/",
      }),
    );
    const body = await bodyOf(res);
    const url = (
      body.data as { components: { components: { url: string }[] }[] }
    ).components[0]!.components[0]!.url;
    expect(url.startsWith("https://gs-admin.example.com/auth?t=")).toBe(true);
  });

  it("never logs the raw token", async () => {
    const { kv, puts } = makeKv();
    await handlePanelCommand(guildInteraction(), makeEnv({ ADMIN_AUTH: kv }));
    const token = puts[0]!.key.slice(ADMIN_TOKEN_PREFIX.length);

    const allLogs = [
      ...(console.log as unknown as ReturnType<typeof vi.fn>).mock.calls,
      ...(console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls,
    ]
      .flat()
      .map(String)
      .join(" ");
    expect(allLogs).not.toContain(token);
  });

  it("falls back to user.id (DM context) when member is absent", async () => {
    const { kv, puts } = makeKv();
    const dm: Interaction = {
      id: "i1",
      application_id: "app1",
      token: "itok",
      type: 2,
      data: { id: "c1", name: "panel", type: 1 },
      user: { id: "dm-user", username: "dmer" },
    };
    await handlePanelCommand(dm, makeEnv({ ADMIN_AUTH: kv }));
    const record = JSON.parse(puts[0]!.value) as { user_id: string };
    expect(record.user_id).toBe("dm-user");
  });

  it("returns an ephemeral error and does NOT issue a token when ADMIN_BASE_URL is missing", async () => {
    const { kv, puts } = makeKv();
    const res = await handlePanelCommand(
      guildInteraction(),
      makeEnv({ ADMIN_AUTH: kv, ADMIN_BASE_URL: "" }),
    );
    const body = await bodyOf(res);
    expect((body.data as { flags: number }).flags).toBe(64);
    expect(puts).toHaveLength(0);
  });
});
