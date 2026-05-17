// Cloudflare DNS API ラッパ。
//
// Phase 1: Worker から `/start <game>` 時に DNS A レコードを Spot EC2 の public IP に更新する
// 用途。事前に `scripts/register-game.sh` (Phase 2 で実装) で record を作成し、
// `cf_record_id` を registry.json に保存しておく前提。
//
// 認証: API Token (Bearer)。Permissions: Zone:DNS:Edit 限定のものを発行する。
//
// 参照: https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-update-dns-record

import { CloudflareApiError, type CloudflareApiErrorDetail } from './errors.js';

export interface CloudflareDnsClientOptions {
  apiToken: string;
  // テスト時にエンドポイントを差し替えるための hook。通常は省略。
  baseUrl?: string;
}

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT';

export interface UpdateRecordInput {
  zoneId: string;
  recordId: string;
  type: DnsRecordType;
  name: string;
  content: string;
  ttl?: number;       // seconds (1 = automatic, otherwise 60-86400)
  proxied?: boolean;
  comment?: string;
}

export interface DnsRecord {
  id: string;
  zoneId: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  result: T | null;
  errors: CloudflareApiErrorDetail[];
  messages: Array<{ code: number; message: string }>;
}

interface RawDnsRecord {
  id: string;
  zone_id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

function normalizeDnsRecord(raw: RawDnsRecord): DnsRecord {
  return {
    id: raw.id,
    zoneId: raw.zone_id,
    type: raw.type,
    name: raw.name,
    content: raw.content,
    ttl: raw.ttl,
    proxied: raw.proxied,
  };
}

export class CloudflareDnsClient {
  private readonly apiToken: string;
  private readonly baseUrl: string;

  constructor(options: CloudflareDnsClientOptions) {
    this.apiToken = options.apiToken;
    this.baseUrl = options.baseUrl ?? 'https://api.cloudflare.com/client/v4';
  }

  // 既存 A レコードの content (IP) を更新する。PATCH なので渡したフィールドのみ更新。
  async updateRecord(input: UpdateRecordInput): Promise<DnsRecord> {
    const url = `${this.baseUrl}/zones/${input.zoneId}/dns_records/${input.recordId}`;
    const payload: Record<string, unknown> = {
      type: input.type,
      name: input.name,
      content: input.content,
      ttl: input.ttl ?? 60,
      proxied: input.proxied ?? false,
    };
    if (input.comment !== undefined) payload['comment'] = input.comment;

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'authorization': `Bearer ${this.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return parseSingleRecordResponse('updateRecord', response);
  }

  // 検証用: record の現在状態を取得。
  async getRecord(zoneId: string, recordId: string): Promise<DnsRecord> {
    const url = `${this.baseUrl}/zones/${zoneId}/dns_records/${recordId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'authorization': `Bearer ${this.apiToken}` },
    });
    return parseSingleRecordResponse('getRecord', response);
  }
}

async function parseSingleRecordResponse(
  operation: string,
  response: Response,
): Promise<DnsRecord> {
  const text = await response.text();
  let parsed: CloudflareApiResponse<RawDnsRecord>;
  try {
    parsed = JSON.parse(text) as CloudflareApiResponse<RawDnsRecord>;
  } catch {
    throw new CloudflareApiError(operation, response.status, `invalid JSON response: ${text.slice(0, 200)}`);
  }

  if (!response.ok || !parsed.success) {
    const summary = parsed.errors.length > 0
      ? parsed.errors.map((e) => `[${e.code}] ${e.message}`).join('; ')
      : `HTTP ${response.status}`;
    throw new CloudflareApiError(operation, response.status, summary, parsed.errors);
  }

  if (parsed.result === null) {
    throw new CloudflareApiError(operation, response.status, 'response.result is null');
  }
  return normalizeDnsRecord(parsed.result);
}
