// CurseForge API client (Phase 7 B-1、docs §3)。
//
// 認証は `x-api-key` header のみ。SDK 不要で fetch だけで完結する。
// gameId=432 (Minecraft) / classId=4471 (ModPacks) を固定で使う。
// CloudflareDnsClient と同じ class + baseUrl hook パターンに揃える。
//
// 参照: https://docs.curseforge.com/rest-api/

import { CurseForgeApiError } from "./errors.js";
import type {
  CurseForgeClientOptions,
  ListFilesOptions,
  ModpackDetail,
  ModpackFile,
  ModpackSummary,
  ReleaseType,
  SearchModpacksOptions,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.curseforge.com";
const MINECRAFT_GAME_ID = 432;
const MODPACKS_CLASS_ID = 4471;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50; // CF API の上限

// ---- CF 生レスポンス型 (実装詳細、外には出さない) ----

interface RawCfFile {
  id: number;
  displayName: string;
  fileName: string;
  fileDate: string;
  releaseType: number;
  downloadUrl: string | null;
  gameVersions?: string[];
}

interface RawCfMod {
  id: number;
  slug: string;
  name: string;
  summary: string;
  logo?: { thumbnailUrl?: string } | null;
  latestFiles?: RawCfFile[];
}

interface CfListResponse<T> {
  data: T[];
}

// ---- 正規化 ----

function normalizeFile(raw: RawCfFile): ModpackFile {
  return {
    fileId: raw.id,
    displayName: raw.displayName,
    fileName: raw.fileName,
    fileDate: raw.fileDate,
    // CF は 1|2|3 のみ返す。型を裏切らないようキャストするが値はそのまま通す。
    releaseType: raw.releaseType as ReleaseType,
    gameVersions: raw.gameVersions ?? [],
    downloadUrl: raw.downloadUrl ?? null,
  };
}

function normalizeSummary(raw: RawCfMod): ModpackSummary {
  const summary: ModpackSummary = {
    modId: raw.id,
    slug: raw.slug,
    name: raw.name,
    summary: raw.summary,
  };
  const thumb = raw.logo?.thumbnailUrl;
  // exactOptionalPropertyTypes: 値があるときだけ key を生やす (undefined を代入しない)。
  if (thumb) summary.thumbnailUrl = thumb;
  return summary;
}

function normalizeDetail(raw: RawCfMod): ModpackDetail {
  return {
    ...normalizeSummary(raw),
    latestFiles: (raw.latestFiles ?? []).map(normalizeFile),
  };
}

function clampPageSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(n)), MAX_PAGE_SIZE);
}

export class CurseForgeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: CurseForgeClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  // gameId=432 + classId=4471 固定で modpack を全文検索する。
  async searchModpacks(
    keyword: string,
    opts?: SearchModpacksOptions,
  ): Promise<ModpackSummary[]> {
    const res = await this.get<CfListResponse<RawCfMod>>(
      "searchModpacks",
      "/v1/mods/search",
      {
        gameId: MINECRAFT_GAME_ID,
        classId: MODPACKS_CLASS_ID,
        searchFilter: keyword,
        pageSize: clampPageSize(opts?.pageSize ?? DEFAULT_PAGE_SIZE),
      },
    );
    return res.data.map(normalizeSummary);
  }

  // slug → modId + メタデータ (latestFiles 含む)。search の slug filter で 1 発引き。
  // 完全一致が無ければ undefined (search は前方一致等で別 slug も返しうるため厳密照合する)。
  async resolveSlug(slug: string): Promise<ModpackDetail | undefined> {
    const res = await this.get<CfListResponse<RawCfMod>>(
      "resolveSlug",
      "/v1/mods/search",
      {
        gameId: MINECRAFT_GAME_ID,
        classId: MODPACKS_CLASS_ID,
        slug,
      },
    );
    const match = res.data.find(
      (m) => m.slug.toLowerCase() === slug.toLowerCase(),
    );
    return match ? normalizeDetail(match) : undefined;
  }

  // 全バージョンの paginated 取得。UI は最新 20 件程度を見せれば十分。
  async listFiles(
    modId: number,
    opts?: ListFilesOptions,
  ): Promise<ModpackFile[]> {
    const res = await this.get<CfListResponse<RawCfFile>>(
      "listFiles",
      `/v1/mods/${modId}/files`,
      {
        pageSize: clampPageSize(opts?.pageSize ?? DEFAULT_PAGE_SIZE),
        index: Math.max(0, Math.floor(opts?.index ?? 0)),
      },
    );
    return res.data.map(normalizeFile);
  }

  // GET 専用の内部ヘルパ。x-api-key を付与し、非 2xx / 不正 JSON / network error を
  // CurseForgeApiError に正規化する。
  private async get<T>(
    operation: string,
    path: string,
    query: Record<string, string | number>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "x-api-key": this.apiKey,
          accept: "application/json",
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new CurseForgeApiError(operation, 0, `network error: ${detail}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new CurseForgeApiError(
        operation,
        response.status,
        text.slice(0, 200),
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CurseForgeApiError(
        operation,
        response.status,
        `invalid JSON response: ${text.slice(0, 200)}`,
      );
    }
  }
}
