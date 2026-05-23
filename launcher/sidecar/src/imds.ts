// EC2 Instance Metadata Service v2 クライアント。
//
// IMDSv2 は session token 必須 (SSRF 防御)。token は PUT で取得し、metadata の GET 時に
// `X-aws-ec2-metadata-token` ヘッダで渡す。token は TTL 内なら再利用できるためキャッシュする。
//
// docs/phase3-plan.md の決定では `GAME_ID` は cloud-init の env で渡す (instance tags の
// metadata 取得を Phase 3 では使わない)。本モジュールが返すのは `instance_id` のみ。

import { log } from './logger.js';

const IMDS_BASE = 'http://169.254.169.254/latest';
// 6 時間。AWS の最大値。
const TOKEN_TTL_SEC = 21_600;
// metadata エンドポイントの HTTP timeout。IMDSv2 は localhost 相当の link-local なので即応する。
const REQUEST_TIMEOUT_MS = 2_000;

interface CachedToken {
  token: string;
  // Date.now() ms。安全側に TTL 残り 1 分を切ったら再取得する。
  expiresAtMs: number;
}

let cached: CachedToken | null = null;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getToken(): Promise<string> {
  if (cached !== null && cached.expiresAtMs > Date.now() + 60_000) {
    return cached.token;
  }
  const res = await fetchWithTimeout(`${IMDS_BASE}/api/token`, {
    method: 'PUT',
    headers: {
      'x-aws-ec2-metadata-token-ttl-seconds': String(TOKEN_TTL_SEC),
    },
  });
  if (!res.ok) {
    throw new Error(`IMDSv2 token request failed: HTTP ${res.status}`);
  }
  const token = await res.text();
  cached = {
    token,
    expiresAtMs: Date.now() + TOKEN_TTL_SEC * 1000,
  };
  log.info('IMDSv2 token acquired');
  return token;
}

async function imdsGet(path: string): Promise<string> {
  const token = await getToken();
  const res = await fetchWithTimeout(`${IMDS_BASE}/${path}`, {
    headers: { 'x-aws-ec2-metadata-token': token },
  });
  if (!res.ok) {
    throw new Error(`IMDSv2 GET ${path} failed: HTTP ${res.status}`);
  }
  return res.text();
}

export async function getInstanceId(): Promise<string> {
  return imdsGet('meta-data/instance-id');
}

export async function getRegion(): Promise<string> {
  return imdsGet('meta-data/placement/region');
}
