// 現 session の tier を保持する store。
//
// tier に応じてコスト系 field の表示/非表示を決める (docs §7、§1.1)。ただし**これは UX に
// 過ぎず、実 enforcement はサーバ側 applyGameUpdate が行う** (§9.1 #2b)。player が直接 API を
// 叩いてコスト field を書き換えても無視される。
import { writable } from "svelte/store";
import type { Tier } from "@gs/shared/registry-types";
import { getSession } from "./api";

export interface SessionState {
  tier: Tier;
  // API 不在 (vite dev 単体 / 未 deploy) で dummy フォールバックしているか。
  usingDummy: boolean;
}

// 読み込み前は null。App.svelte の onMount で loadSession() が解決する。
export const session = writable<SessionState | null>(null);

export async function loadSession(): Promise<void> {
  try {
    const s = await getSession();
    session.set({ tier: s.tier, usingDummy: false });
  } catch {
    // API 不在時は admin として全 field を表示する (player 表示は previewTier で確認可)。
    session.set({ tier: "admin", usingDummy: true });
  }
}

// dummy モードのみ: admin/player 表示の差を確認するための tier 切り替え。
// usingDummy=false (実 session) のときは何もしない (本物の tier はサーバが決める)。
export function previewTier(tier: Tier): void {
  session.update((s) => (s !== null && s.usingDummy ? { ...s, tier } : s));
}
