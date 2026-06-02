// admin-webui の JSON API への薄い fetch ラッパ。
//
// 認証は Cookie session 前提なので credentials: same-origin。状態変更系 (PUT/POST) は
// X-Requested-With を付ける (CSRF 軽減、docs §4.3 / §9.1 #5)。
import type { GameDefinition, Tier } from "@gs/shared/registry-types";
import type { ModpackFile, ModpackSummary } from "@gs/shared/modpack-types";

const API_BASE = "/admin/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new ApiError(res.status, `GET ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

// 状態変更系 (PUT/POST)。サーバが要求する X-Requested-With を付ける (CSRF 軽減)。
async function apiSend<T>(
  method: "PUT" | "POST",
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-requested-with": "fetch",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new ApiError(res.status, `${method} ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

// game 一覧。handlers/games.ts の listHandler が { games: [...] } を返す。
export async function listGames(): Promise<GameDefinition[]> {
  const body = await apiGet<{ games: GameDefinition[] }>("/games");
  return body.games;
}

// game 単体。getHandler が { game: {...} } を返す。未登録は ApiError(404)。
export async function getGame(id: string): Promise<GameDefinition> {
  const body = await apiGet<{ game: GameDefinition }>(
    `/games/${encodeURIComponent(id)}`,
  );
  return body.game;
}

// 部分更新。サーバは tier に応じてコスト系 field を enforcement した最終形を返す
// ({ game: ... }、handlers/games.ts putHandler / applyGameUpdate)。
export async function updateGame(
  id: string,
  patch: Partial<GameDefinition>,
): Promise<GameDefinition> {
  const body = await apiSend<{ game: GameDefinition }>(
    "PUT",
    `/games/${encodeURIComponent(id)}`,
    patch,
  );
  return body.game;
}

// 現 session の whoami。tier に応じて UI のコスト系 field 表示を切り替える (docs §6 / §7)。
export async function getSession(): Promise<{ userId: string; tier: Tier }> {
  return apiGet<{ userId: string; tier: Tier }>("/auth/session");
}

// ---- modpack 検索 (新規追加フロー、D-1 endpoint を叩く) ----

// keyword で CurseForge modpack を検索。handlers/modpacks.ts が { modpacks } を返す。
export async function searchModpacks(
  keyword: string,
): Promise<ModpackSummary[]> {
  const body = await apiGet<{ modpacks: ModpackSummary[] }>(
    `/modpacks/search?q=${encodeURIComponent(keyword)}`,
  );
  return body.modpacks;
}

// slug → メタ + 版一覧。handlers/modpacks.ts が { modpack, files } を返す。未存在は ApiError(404)。
export async function getModpackBySlug(
  slug: string,
): Promise<{ modpack: ModpackSummary; files: ModpackFile[] }> {
  return apiGet<{ modpack: ModpackSummary; files: ModpackFile[] }>(
    `/modpacks/by-slug/${encodeURIComponent(slug)}`,
  );
}

// 新規ゲーム追加 (D-2)。サーバが validate → DNS A 作成 → KV put し、作られた game を返す
// ({ game: ... }、handlers/games.ts postHandler / buildGameDefinition)。失敗は ApiError。
export async function createGame(
  form: Record<string, unknown>,
): Promise<GameDefinition> {
  const body = await apiSend<{ game: GameDefinition }>("POST", "/games", form);
  return body.game;
}
