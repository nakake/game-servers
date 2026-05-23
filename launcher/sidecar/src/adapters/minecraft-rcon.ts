// Minecraft RCON で `list` コマンドを実行 → `empty_pattern` でマッチした行を idle とみなす。
// registry.idle_check.config の例 (games/<game>/registry.json、minecraft 系の game 共通):
//   { host: "localhost", port: 25575, command: "list", empty_pattern: "There are 0 of a max" }

import { Rcon } from 'rcon-client';

import type { AdapterCheckResult, IdleAdapter } from './types.js';

interface MinecraftRconConfig {
  host: string;
  port: number;
  command: string;
  emptyPattern: string;
}

function readConfig(raw: Record<string, unknown>): MinecraftRconConfig {
  const host = typeof raw['host'] === 'string' ? raw['host'] : 'localhost';
  const port = typeof raw['port'] === 'number' ? raw['port'] : 25575;
  const command = typeof raw['command'] === 'string' ? raw['command'] : 'list';
  const emptyPattern =
    typeof raw['empty_pattern'] === 'string' ? raw['empty_pattern'] : 'There are 0';
  return { host, port, command, emptyPattern };
}

// `list` のレスポンスから player_count を抽出する。Minecraft の応答例:
//   "There are 0 of a max of 20 players online: "
//   "There are 3 of a max of 20 players online: Alice, Bob, Carol"
// パース失敗時は -1 (unknown) を返す。
export function parsePlayerCount(response: string): number {
  const m = /There are (\d+)/.exec(response);
  if (m === null || m[1] === undefined) return -1;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : -1;
}

// `list` レスポンスが `empty_pattern` を含むか。idle 判定の真理値。
export function isIdleResponse(response: string, emptyPattern: string): boolean {
  return response.includes(emptyPattern);
}

export const minecraftRconAdapter: IdleAdapter = {
  async check({ config, password }): Promise<AdapterCheckResult> {
    const c = readConfig(config);
    const rcon = await Rcon.connect({
      host: c.host,
      port: c.port,
      password,
      timeout: 5_000,
    });
    try {
      const response = await rcon.send(c.command);
      return {
        playerCount: parsePlayerCount(response),
        idle: isIdleResponse(response, c.emptyPattern),
      };
    } finally {
      await rcon.end().catch(() => undefined);
    }
  },
};
