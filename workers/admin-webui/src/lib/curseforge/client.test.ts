import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CurseForgeClient } from "./client.js";
import { CurseForgeApiError } from "./errors.js";

const BASE = "https://cf.test";
const API_KEY = "test-key";

function makeClient(): CurseForgeClient {
  return new CurseForgeClient({ apiKey: API_KEY, baseUrl: BASE });
}

// JSON を返す fetch mock を仕込む。
function stubJson(body: unknown, init?: { status?: number }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: init?.status ?? 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

// 最後の fetch 呼び出しの URL (パース済み) と init を取り出す。
function lastFetch(): { url: URL; init: RequestInit } {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  expect(fetchMock).toHaveBeenCalled();
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
    string,
    RequestInit,
  ];
  return { url: new URL(call[0]), init: call[1] };
}

// CF mod (生レスポンス相当) を組み立てる。
function rawMod(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 999,
    slug: "all-the-mods-10",
    name: "All The Mods 10",
    summary: "kitchen sink modpack",
    logo: { thumbnailUrl: "https://cf.test/logo.png" },
    latestFiles: [rawFile()],
    ...overrides,
  };
}

function rawFile(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 5001,
    displayName: "ServerFiles-3.10",
    fileName: "ServerFiles-3.10.zip",
    fileDate: "2026-01-01T00:00:00Z",
    releaseType: 1,
    downloadUrl: "https://cf.test/dl/5001",
    gameVersions: ["1.21.1", "NeoForge"],
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CurseForgeClient.searchModpacks", () => {
  it("hits /v1/mods/search with fixed gameId/classId + searchFilter + x-api-key", async () => {
    stubJson({ data: [rawMod()] });
    await makeClient().searchModpacks("all the mods");

    const { url, init } = lastFetch();
    expect(url.origin + url.pathname).toBe(`${BASE}/v1/mods/search`);
    expect(url.searchParams.get("gameId")).toBe("432");
    expect(url.searchParams.get("classId")).toBe("4471");
    expect(url.searchParams.get("searchFilter")).toBe("all the mods");
    expect(url.searchParams.get("pageSize")).toBe("20");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(API_KEY);
    expect(init.method).toBe("GET");
  });

  it("normalizes results (id→modId, logo.thumbnailUrl→thumbnailUrl)", async () => {
    stubJson({ data: [rawMod()] });
    const results = await makeClient().searchModpacks("atm");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      modId: 999,
      slug: "all-the-mods-10",
      name: "All The Mods 10",
      summary: "kitchen sink modpack",
      thumbnailUrl: "https://cf.test/logo.png",
    });
  });

  it("omits thumbnailUrl when logo is null/missing", async () => {
    stubJson({ data: [rawMod({ logo: null })] });
    const results = await makeClient().searchModpacks("atm");
    expect(results[0]).not.toHaveProperty("thumbnailUrl");
  });

  it("returns [] when data is empty", async () => {
    stubJson({ data: [] });
    const results = await makeClient().searchModpacks("nonexistent");
    expect(results).toEqual([]);
  });

  it("clamps pageSize to the CF max of 50", async () => {
    stubJson({ data: [] });
    await makeClient().searchModpacks("x", { pageSize: 999 });
    expect(lastFetch().url.searchParams.get("pageSize")).toBe("50");
  });

  it("clamps pageSize to a minimum of 1", async () => {
    stubJson({ data: [] });
    await makeClient().searchModpacks("x", { pageSize: 0 });
    expect(lastFetch().url.searchParams.get("pageSize")).toBe("1");
  });
});

describe("CurseForgeClient.resolveSlug", () => {
  it("returns detail with normalized latestFiles on exact slug match", async () => {
    stubJson({ data: [rawMod()] });
    const detail = await makeClient().resolveSlug("all-the-mods-10");

    expect(detail).toBeDefined();
    expect(detail?.modId).toBe(999);
    expect(detail?.latestFiles).toHaveLength(1);
    expect(detail?.latestFiles[0]).toMatchObject({
      fileId: 5001,
      releaseType: 1,
      gameVersions: ["1.21.1", "NeoForge"],
      downloadUrl: "https://cf.test/dl/5001",
    });
    // slug filter を渡していること。
    expect(lastFetch().url.searchParams.get("slug")).toBe("all-the-mods-10");
  });

  it("matches slug case-insensitively", async () => {
    stubJson({ data: [rawMod({ slug: "All-The-Mods-10" })] });
    const detail = await makeClient().resolveSlug("all-the-mods-10");
    expect(detail?.modId).toBe(999);
  });

  it("returns undefined when no entry matches the slug exactly", async () => {
    // search が前方一致で別 slug を返してきても拾わない。
    stubJson({ data: [rawMod({ slug: "all-the-mods-10-lite" })] });
    const detail = await makeClient().resolveSlug("all-the-mods-10");
    expect(detail).toBeUndefined();
  });

  it("returns undefined when data is empty", async () => {
    stubJson({ data: [] });
    expect(await makeClient().resolveSlug("whatever")).toBeUndefined();
  });

  it("tolerates a mod with no latestFiles (→ empty array)", async () => {
    stubJson({ data: [rawMod({ latestFiles: undefined })] });
    const detail = await makeClient().resolveSlug("all-the-mods-10");
    expect(detail?.latestFiles).toEqual([]);
  });
});

describe("CurseForgeClient.listFiles", () => {
  it("hits /v1/mods/:id/files with pageSize + index", async () => {
    stubJson({ data: [rawFile()] });
    await makeClient().listFiles(999, { pageSize: 5, index: 10 });

    const { url } = lastFetch();
    expect(url.origin + url.pathname).toBe(`${BASE}/v1/mods/999/files`);
    expect(url.searchParams.get("pageSize")).toBe("5");
    expect(url.searchParams.get("index")).toBe("10");
  });

  it("passes downloadUrl=null through (distribution NG modpack)", async () => {
    stubJson({ data: [rawFile({ downloadUrl: null })] });
    const files = await makeClient().listFiles(999);
    expect(files[0]?.downloadUrl).toBeNull();
  });

  it("defaults gameVersions to [] when missing", async () => {
    stubJson({ data: [rawFile({ gameVersions: undefined })] });
    const files = await makeClient().listFiles(999);
    expect(files[0]?.gameVersions).toEqual([]);
  });
});

describe("CurseForgeClient error handling", () => {
  it("throws CurseForgeApiError on non-2xx with the status code", async () => {
    stubJson({ error: "forbidden" }, { status: 403 });
    await expect(makeClient().searchModpacks("x")).rejects.toMatchObject({
      name: "CurseForgeApiError",
      statusCode: 403,
    });
  });

  it("marks 5xx / 429 as retryable and 4xx as not", async () => {
    const e500 = new CurseForgeApiError("op", 500, "boom");
    const e429 = new CurseForgeApiError("op", 429, "slow down");
    const e403 = new CurseForgeApiError("op", 403, "nope");
    const eNet = new CurseForgeApiError("op", 0, "network");
    expect(e500.isRetryable).toBe(true);
    expect(e429.isRetryable).toBe(true);
    expect(e403.isRetryable).toBe(false);
    expect(eNet.isRetryable).toBe(true);
  });

  it("throws CurseForgeApiError on invalid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>not json</html>", { status: 200 })),
    );
    await expect(makeClient().searchModpacks("x")).rejects.toBeInstanceOf(
      CurseForgeApiError,
    );
  });

  it("wraps fetch network errors as statusCode 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    await expect(makeClient().searchModpacks("x")).rejects.toMatchObject({
      statusCode: 0,
    });
  });
});
