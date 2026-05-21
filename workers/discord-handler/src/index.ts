// Discord interaction handler — entry point.
//
// Phase 1 (現在): /ping, /health, /admin/docker-stop (検証専用)。
// Phase 1 後半で /discord/interaction, /aws/notification を追加する。

import { handleAdminDockerStop } from './handlers/admin.js';
import { handleAwsNotification } from './handlers/aws-notification.js';
import { handleVolumeCleanup } from './handlers/cleanup.js';
import { handleDiscordInteraction } from './handlers/discord.js';
import { handleSnapshotRetention } from './handlers/snapshot-retention.js';
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

    if (request.method === 'POST' && url.pathname === '/admin/docker-stop') {
      return handleAdminDockerStop(request, env);
    }

    return new Response('Not Found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },

  // Cron Trigger (wrangler.toml [triggers] crons)。2 つの後追い処理を回す:
  //   - handleVolumeCleanup    : `/stop` が予約した「snapshot 完成後に削除する volume」を回収
  //   - handleSnapshotRetention: game-world snapshot を registry の generations 世代に絞る
  // 互いに独立 (volume 削除 vs snapshot 削除) なので個別の waitUntil で並行に走らせる。
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleVolumeCleanup(env));
    ctx.waitUntil(handleSnapshotRetention(env));
  },
} satisfies ExportedHandler<Env>;
