// Cloudflare API ラッパの公開窓口。Phase 1 は DNS のみ。

export { CloudflareDnsClient } from './dns.js';
export type {
  CloudflareDnsClientOptions,
  UpdateRecordInput,
  DnsRecord,
  DnsRecordType,
} from './dns.js';

export { CloudflareApiError } from './errors.js';
export type { CloudflareApiErrorDetail } from './errors.js';
