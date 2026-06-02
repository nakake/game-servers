// 現 session の状態を保持する store。
//
// tier に応じてコスト系 field の表示/非表示を決める (docs §7、§1.1)。ただし**これは UX に
// 過ぎず、実 enforcement はサーバ側 applyGameUpdate が行う** (§9.1 #2b)。
//
// 認証状態は 3 つに分ける:
//   - authed=true,  usingDummy=false : ログイン済 (実データ)
//   - authed=false                   : 未ログイン (API が 401)。**ダミーは出さずログイン誘導**
//   - authed=true,  usingDummy=true  : バックエンド不在 (vite dev 単体)。dev 用に dummy 動作
import { writable } from "svelte/store";
import type { Tier } from "@gs/shared/registry-types";
import { getSession, ApiError } from "./api";

export interface SessionState {
  // false = 未ログイン (API が 401 を返した)。本番でこの状態のときは偽データを見せない。
  authed: boolean;
  // authed=true のときのみ意味を持つ。
  tier: Tier;
  // バックエンド不在 (ローカル dev) で dummy 動作中か。本番では false。
  usingDummy: boolean;
}

// 読み込み前は null。App.svelte の onMount で loadSession() が解決する。
export const session = writable<SessionState | null>(null);

export async function loadSession(): Promise<void> {
  try {
    const s = await getSession();
    session.set({ authed: true, tier: s.tier, usingDummy: false });
  } catch (e) {
    if (e instanceof ApiError) {
      // サーバは応答している (デプロイ済) が未認証。401 等 → 未ログイン。
      // ここで dummy を出さない (未ログインに偽データを見せず、ログインへ誘導する)。
      session.set({ authed: false, tier: "player", usingDummy: false });
    } else {
      // fetch 自体が失敗 = バックエンド不在 (vite dev 単体)。dev 用に dummy で動かす。
      session.set({ authed: true, tier: "admin", usingDummy: true });
    }
  }
}

// dummy モードのみ: admin/player 表示の差を確認するための tier 切り替え。
// usingDummy=false (実 session) のときは何もしない (本物の tier はサーバが決める)。
export function previewTier(tier: Tier): void {
  session.update((s) => (s !== null && s.usingDummy ? { ...s, tier } : s));
}
