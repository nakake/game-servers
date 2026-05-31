// CurseForge API ラッパの公開ドメイン型 (Phase 7 B-1、docs §3.1)。
//
// CF API の生レスポンス (snake/camel 混在・logo オブジェクト・id の二義性) は client.ts 内で
// 正規化し、ここで定義する clean な型に変換してから handler / SPA に渡す。
// CF ワイヤ型 (RawCf*) は実装詳細なので client.ts に閉じる。

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
