// Discord interaction endpoint。
//
// Phase 1: PING/PONG + /list (即時 response)。/start, /stop, /status は次ステップで追加。

import { verifyDiscordRequest } from '../lib/discord/verify.js';
import {
  InteractionType,
  InteractionResponseType,
  type Interaction,
} from '../lib/discord/types.js';
import { handleListCommand } from './discord/list.js';
import { handleStartCommand } from './discord/start.js';
import { handleStopCommand } from './discord/stop.js';
import { handleStatusCommand } from './discord/status.js';
import type { Env } from '../env.js';

export async function handleDiscordInteraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (env.DISCORD_PUBLIC_KEY === undefined || env.DISCORD_PUBLIC_KEY === '') {
    return new Response('DISCORD_PUBLIC_KEY not configured\n', { status: 500 });
  }

  const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
  if (!valid) {
    return new Response('invalid request signature\n', { status: 401 });
  }

  let interaction: Interaction;
  try {
    interaction = JSON.parse(body) as Interaction;
  } catch {
    return new Response('invalid JSON\n', { status: 400 });
  }

  if (interaction.type === InteractionType.PING) {
    return Response.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return dispatchCommand(interaction, env, ctx);
  }

  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: 'Unsupported interaction type' },
  });
}

function dispatchCommand(interaction: Interaction, env: Env, ctx: ExecutionContext): Response {
  const commandName = interaction.data?.name;
  switch (commandName) {
    case 'list':
      return handleListCommand();
    case 'start':
      return handleStartCommand(interaction, env, ctx);
    case 'stop':
      return handleStopCommand(interaction, env, ctx);
    case 'status':
      return handleStatusCommand(interaction, env, ctx);
    default:
      return Response.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `Unknown command: \`/${commandName ?? '?'}\`` },
      });
  }
}
