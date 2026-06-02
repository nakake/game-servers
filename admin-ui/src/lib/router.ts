// 依存ゼロの最小クライアントルータ。
//
// SPA は admin-webui の not_found_handling=single-page-application で配信され、
// 全パスが index.html に fallback する (docs §7.3)。よって pathname を読んで描画を
// 切り替えるだけでよい。ライブラリを足さないのは bundle size を小さく保つため (docs §7.1)。
import { readable } from "svelte/store";

export interface Route {
  // 正規化済みパス (末尾スラッシュ除去)。
  path: string;
  // /games/:id の id 部分。一覧 (/ や /games) や新規追加では null。
  gameId: string | null;
  // /games/new (新規追加フォーム) か。
  isNew: boolean;
}

function parse(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  // /games/new は :id より先に判定する (gameId="new" と誤解釈させない)。
  if (path === "/games/new") {
    return { path, gameId: null, isNew: true };
  }
  const m = path.match(/^\/games\/([^/]+)$/);
  if (m !== null) {
    return { path, gameId: decodeURIComponent(m[1]!), isNew: false };
  }
  return { path, gameId: null, isNew: false };
}

// 現在のルート。popstate (ブラウザの戻る/進む) と navigate() で更新される。
export const route = readable<Route>(parse(window.location.pathname), (set) => {
  const onPop = (): void => set(parse(window.location.pathname));
  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
});

// プログラム遷移。history に積み、popstate を自前発火して route store を更新する。
export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
