// getGameStatus — 単一 game の状態を返す Discord 非依存コア (Phase 7 E-1)。
//
// Discord `/status` は Project タグで全 running を列挙する別物 (handlers/discord/status.ts)。
// こちらは admin-webui の `GET /games/:id/status` RPC (InternalRpc.status) 用に、Game タグで
// 1 ゲームだけを引き、@gs/shared の StatusResult 契約に正規化する (docs §6)。

import {
  AwsApiClient,
  describeInstancesByTag,
  getAwsCredentials,
} from '../aws/index.js';
import type { InstanceState } from '../aws/index.js';
import type { ServerState, StatusResult } from '@gs/shared/rpc-types';
import type { GameDefinition } from '../registry/types.js';
import type { Env } from '../../env.js';

// EC2 の instance-state-name → 契約上の ServerState へ畳む。
export function toServerState(state: InstanceState): ServerState {
  switch (state) {
    case 'running':
      return 'running';
    case 'pending':
      return 'pending';
    case 'stopping':
    case 'shutting-down':
      return 'stopping';
    case 'stopped':
    case 'terminated':
      return 'stopped';
    default:
      return 'unknown';
  }
}

export async function getGameStatus(
  env: Env,
  ctx: ExecutionContext,
  game: GameDefinition,
): Promise<StatusResult> {
  const gameId = game.game_id;
  const credentials = await getAwsCredentials(env, ctx);
  const ec2 = new AwsApiClient({
    region: env.AWS_REGION ?? 'ap-northeast-1',
    credentials,
  });

  // 起動中〜停止遷移中まで拾う。terminated は通常 tag 検索から消えるが念のため含める。
  // instance が 1 つも無い = 停止済み (我々の /stop は terminate するため stopped 相当)。
  const insts = await describeInstancesByTag(ec2, { Game: gameId }, [
    'pending',
    'running',
    'shutting-down',
    'stopping',
  ]);
  const inst = insts[0];
  if (inst === undefined) {
    return { game_id: gameId, state: 'stopped' };
  }

  const state = toServerState(inst.state);
  const result: StatusResult = {
    game_id: gameId,
    state,
    instance_id: inst.instanceId,
  };
  if (state === 'running' && inst.publicIp !== undefined) {
    const port = game.ports[0]?.port ?? 25565;
    result.endpoint = `${game.subdomain}.${env.CLOUDFLARE_BASE_DOMAIN}:${port}`;
  }
  return result;
}
