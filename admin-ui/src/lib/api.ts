// admin-webui の JSON API への薄い fetch ラッパ。
//
// 認証は Cookie session 前提なので credentials: same-origin。状態変更系 (PUT/POST) は
// X-Requested-With を付ける (CSRF 軽減、docs §4.3 / §9.1 #5)。更新系は C-2 以降で追加する。
import type { GameDefinition } from "@gs/shared/registry-types";

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
