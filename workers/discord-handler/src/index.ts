// Discord interaction handler — entry point.
//
// Phase 1 (現在): /ping, /health, /admin/docker-stop (検証専用)。
// Phase 1 後半で /discord/interaction, /aws/notification を追加する。

import { handleAdminDockerStop } from './handlers/admin.js';
import { handleAwsNotification } from './handlers/aws-notification.js';
import { handleVolumeCleanup } from './handlers/cleanup.js';
import { handleDiscordInteraction } from './handlers/discord.js';
import { handleIdleFallback } from './handlers/idle-fallback.js';
import { handleSidecarHeartbeat } from './handlers/sidecar/heartbeat.js';
import { handleSidecarIdleDetected } from './handlers/sidecar/idle-detected.js';
import { handleSidecarRegistry } from './handlers/sidecar/registry.js';
import { handleSnapshotRetention } from './handlers/snapshot-retention.js';
import { buildDiscoveryDocument, buildJwks, deriveIssuerUrl } from './lib/auth/oidc-issuer.js';
import type { Env } from './env.js';

export type { Env };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/ping') {
      return new Response('pong\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        worker: 'discord-handler',
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method === 'POST' && url.pathname === '/discord/interaction') {
      return handleDiscordInteraction(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/aws/notification') {
      return handleAwsNotification(request, env, ctx);
    }

    // /sidecar/* — sidecar (EC2 内) と Worker の HMAC 認証付きエンドポイント (Phase 3)。
    // CORS / Discord 署名は不要 (HMAC 認証で守られる)。
    if (request.method === 'POST' && url.pathname === '/sidecar/heartbeat') {
      return handleSidecarHeartbeat(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/sidecar/idle-detected') {
      return handleSidecarIdleDetected(request, env, ctx);
    }
    if (request.method === 'GET' && url.pathname === '/sidecar/registry') {
      return handleSidecarRegistry(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/admin/docker-stop') {
      return handleAdminDockerStop(request, env, ctx);
    }

    // /oidc/.well-known/* — Phase 5 OIDC issuer endpoints (public、JWKS + discovery doc のみ)。
    // 主防御は edge cache (s-maxage=86400) によるオリジン到達抑制。
    // 注: signOidcToken を expose する route を絶対追加しない (oidc-issuer.ts で module-private)。
    if (request.method === 'GET' && url.pathname === '/oidc/.well-known/openid-configuration') {
      const issuerUrl = deriveIssuerUrl(env);
      return Response.json(buildDiscoveryDocument(issuerUrl), {
        headers: { 'cache-control': 'public, max-age=3600, s-maxage=86400' },
      });
    }
    if (request.method === 'GET' && url.pathname === '/oidc/.well-known/jwks.json') {
      const jwks = await buildJwks(env);
      return Response.json(jwks, {
        headers: { 'cache-control': 'public, max-age=3600, s-maxage=86400' },
      });
    }

    return new Response('Not Found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },

  // Cron Trigger (wrangler.toml [triggers] crons)。3 つの後追い処理を回す:
  //   - handleVolumeCleanup    : `/stop` が予約した「snapshot 完成後に削除する volume」を回収
  //   - handleSnapshotRetention: game-world snapshot を registry の generations 世代に絞る
  //   - handleIdleFallback     : sidecar が沈黙した game を強制停止 (Phase 3 Step 3、保険経路)
  // 互いに独立 (volume 削除 vs snapshot 削除 vs idle 判定) なので個別の waitUntil で並行に走らせる。
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleVolumeCleanup(env, ctx));
    ctx.waitUntil(handleSnapshotRetention(env, ctx));
    ctx.waitUntil(handleIdleFallback(env, ctx).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
