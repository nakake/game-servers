// CurseForge modpack の公開ドメイン型 (Phase 7、docs §3.1)。
//
// admin-webui の CF client が CF 生レスポンスを正規化して返す型であり、admin-webui の
// modpacks handler と SPA (admin-ui) の両方が API 契約として使う。よって @gs/shared に置く
// (registry-types を共有したのと同じ理由)。CF ワイヤ型 (RawCf*) は admin-webui の client.ts
// に閉じたまま。ADR 0004 どおり AWS ロジックは入れない (純粋な型 + 変換のみ)。

import type { ModLoader } from "./registry-types.js";

// CurseForge の release チャネル。1=release / 2=beta / 3=alpha。
export type ReleaseType = 1 | 2 | 3;

// modpack の 1 バージョン (server file)。
export interface ModpackFile {
  fileId: number;
  displayName: string; // 例: "ServerFiles-3.10"
  fileName: string;
  fileDate: string; // ISO8601
  releaseType: ReleaseType;
  gameVersions: string[]; // 例: ["1.21.1", "NeoForge"]
  downloadUrl: string | null; // null なら distribution NG (CF が DL URL を出さない)
}

// 検索結果 1 件 (一覧表示用、バージョン情報は含まない)。
export interface ModpackSummary {
  modId: number;
  slug: string;
  name: string;
  summary: string;
  thumbnailUrl?: string;
}

// modpack 詳細 (slug 解決の戻り)。CF search は latestFiles を同梱するので 1 call で得られる。
export interface ModpackDetail extends ModpackSummary {
  latestFiles: ModpackFile[];
}

// CF gameVersions ("1.21.1", "NeoForge" 等の混在配列) から Minecraft バージョンと
// mod loader を推定する。新規追加フォームの cf_modpack_meta 既定値に使う (純粋・テスト可)。
// 推定できない要素は null を返し、UI 側で利用者が補正できるようにする。
export function deriveModpackMeta(gameVersions: string[]): {
  minecraftVersion: string | null;
  modLoader: ModLoader | null;
} {
  let minecraftVersion: string | null = null;
  let modLoader: ModLoader | null = null;
  for (const v of gameVersions) {
    if (/^\d+\.\d+(\.\d+)?$/.test(v)) {
      minecraftVersion ??= v;
    } else {
      const loader = normalizeLoader(v);
      if (loader !== null) modLoader ??= loader;
    }
  }
  return { minecraftVersion, modLoader };
}

function normalizeLoader(s: string): ModLoader | null {
  switch (s.toLowerCase()) {
    case "neoforge":
      return "NEOFORGE";
    case "forge":
      return "FORGE";
    case "fabric":
      return "FABRIC";
    case "quilt":
      return "QUILT";
    default:
      return null;
  }
}
