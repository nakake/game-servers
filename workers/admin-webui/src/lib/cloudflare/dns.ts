// Cloudflare DNS API ラッパ (admin-webui 側、Phase 7 D-2)。
//
// 新規ゲーム追加 (POST /admin/api/games) で <subdomain>.<base_domain> の A レコードを
// placeholder IP (0.0.0.0) で作成する。実 IP は /start 時に discord-handler が
// updateRecord で書き換える (起動毎に Spot EC2 の public IP へ更新する設計)。
//
// register-game.mjs の ensureDnsRecord と同じ **冪等** 動作: 既存 A があれば作らず id を返す。
// admin-webui は Cloudflare DNS を自前で扱う (ADR 0004。AWS/OIDC 鍵のみ隔離対象で、DNS は対象外)。
//
// 認証: API Token (Bearer)。Permissions は Zone:DNS:Edit 限定のものを発行する。

import { CloudflareApiError, type CloudflareApiErrorDetail } from "./errors.js";

export interface CloudflareDnsClientOptions {
  apiToken: string;
  // テスト時にエンドポイントを差し替える hook。通常は省略。
  baseUrl?: string;
}

export interface EnsureARecordInput {
  zoneId: string;
  name: string; // FQDN (例: "atm10.nakake.com")
  content?: string; // 既定 "0.0.0.0" (placeholder)
  comment?: string;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  result: T | null;
  errors: CloudflareApiErrorDetail[];
}

interface RawDnsRecord {
  id: string;
}

export class CloudflareDnsClient {
  private readonly apiToken: string;
  private readonly baseUrl: string;

  constructor(options: CloudflareDnsClientOptions) {
    this.apiToken = options.apiToken;
    this.baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4";
  }

  // 既存 A レコードがあれば id を返し、無ければ作成する (冪等)。返り値は record id。
  async ensureARecord(input: EnsureARecordInput): Promise<string> {
    const existing = await this.findARecordId(input.zoneId, input.name);
    if (existing !== null) return existing;
    return this.createARecord(input);
  }

  // <name> の A レコード id を 1 件返す。無ければ null。
  async findARecordId(zoneId: string, name: string): Promise<string | null> {
    const url =
      `${this.baseUrl}/zones/${zoneId}/dns_records` +
      `?type=A&name=${encodeURIComponent(name)}`;
    const res = await this.fetchJson<RawDnsRecord[]>("listDnsRecords", url, {
      method: "GET",
    });
    const first = Array.isArray(res) ? res[0] : undefined;
    return first?.id ?? null;
  }

  private async createARecord(input: EnsureARecordInput): Promise<string> {
    const url = `${this.baseUrl}/zones/${input.zoneId}/dns_records`;
    const body: Record<string, unknown> = {
      type: "A",
      name: input.name,
      content: input.content ?? "0.0.0.0",
      ttl: 60,
      proxied: false,
    };
    if (input.comment !== undefined) body["comment"] = input.comment;

    const res = await this.fetchJson<RawDnsRecord>("createDnsRecord", url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.id;
  }

  // Bearer 認証を付けて呼び、success / result を検証して result を返す。
  // network error は statusCode=0、非 2xx / success:false は CF の errors を畳んで投げる。
  private async fetchJson<T>(
    operation: string,
    url: string,
    init: RequestInit,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new CloudflareApiError(operation, 0, `network error: ${detail}`);
    }

    const text = await response.text();
    let parsed: CloudflareApiResponse<T>;
    try {
      parsed = JSON.parse(text) as CloudflareApiResponse<T>;
    } catch {
      throw new CloudflareApiError(
        operation,
        response.status,
        `invalid JSON response: ${text.slice(0, 200)}`,
      );
    }

    if (!response.ok || !parsed.success) {
      const summary =
        parsed.errors?.length > 0
          ? parsed.errors.map((e) => `[${e.code}] ${e.message}`).join("; ")
          : `HTTP ${response.status}`;
      throw new CloudflareApiError(
        operation,
        response.status,
        summary,
        parsed.errors ?? [],
      );
    }

    if (parsed.result === null) {
      throw new CloudflareApiError(
        operation,
        response.status,
        "response.result is null",
      );
    }
    return parsed.result;
  }
}
