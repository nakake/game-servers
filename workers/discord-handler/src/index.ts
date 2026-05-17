// Discord interaction handler — entry point.
//
// Phase 1 (現在): /ping, /health, /admin/docker-stop (検証専用)。
// Phase 1 後半で /discord/interaction, /aws/notification を追加する。

import { handleAdminDockerStop } from './handlers/admin.js';
import { handleDiscordInteraction } from './handlers/discord.js';
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

    if (request.method === 'POST' && url.pathname === '/admin/docker-stop') {
      return handleAdminDockerStop(request, env);
    }

    return new Response('Not Found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
} satisfies ExportedHandler<Env>;
