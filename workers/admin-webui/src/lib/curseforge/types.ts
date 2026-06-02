// CurseForge API ラッパの公開ドメイン型 (Phase 7 B-1、docs §3.1)。
//
// modpack のドメイン型 (ReleaseType / ModpackFile / ModpackSummary / ModpackDetail) は
// SPA とも共有する API 契約なので D-3 で @gs/shared/modpack-types へ移設した。ここでは
// 後方互換のため re-export し、CF client 固有のオプション型だけをローカルに持つ。
// CF ワイヤ型 (RawCf*) は実装詳細なので client.ts に閉じる。

export type {
  ReleaseType,
  ModpackFile,
  ModpackSummary,
  ModpackDetail,
} from "@gs/shared/modpack-types";

export interface CurseForgeClientOptions {
  apiKey: string;
  // テスト時にエンドポイントを差し替えるための hook。通常は省略。
  baseUrl?: string;
}

export interface SearchModpacksOptions {
  // CF の上限は 50。既定 20 (UI は最新数件見せれば十分、docs §3.1)。
  pageSize?: number;
}

export interface ListFilesOptions {
  pageSize?: number;
  index?: number; // ページネーション開始 index
}
