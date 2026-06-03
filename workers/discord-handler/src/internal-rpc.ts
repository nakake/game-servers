// InternalRpc — admin-webui が Service Binding 経由で呼ぶ AWS 操作の RPC 面 (Phase 7 E-1)。
//
// ADR 0004 / docs §6.1: AWS/OIDC 鍵は discord-handler に閉じ、admin-webui には複製しない。
// admin-webui は `env.DISCORD_HANDLER.start(id)` のように WorkerEntrypoint のメソッドを呼ぶだけ。
//
// WorkerEntrypoint のメソッドは **Service Binding 経由でしか到達できず外部 URL からは叩けない**
// (A-2 決定)。よって共有 secret / header 検証は不要。`this.env` / `this.ctx` から既存の
// orchestrator (start/stop/status) をそのまま呼ぶ。戻り値は @gs/shared/rpc-types の契約。
//
// 進捗 (onProgress) は使わない: Web 側は polling で status を引く設計 (docs §6.1)。
// 起動完了の Discord 通知 (pending-ready) も張らない — それは Discord `/start` 固有の文脈。

import { WorkerEntrypoint } from 'cloudflare:workers';

import type {
  InternalRpcInterface,
  StartResult,
  StatusResult,
  StopResult,
} from '@gs/shared/rpc-types';
import { runStartWorkflow } from './lib/orchestrator/start.js';
import { getGameStatus } from './lib/orchestrator/status.js';
import { getGame } from './lib/registry/store.js';
import { runStopWorkflow } from './handlers/stop-workflow.js';
import type { Env } from './env.js';

export class InternalRpc
  extends WorkerEntrypoint<Env>
  implements InternalRpcInterface
{
  // ゲームを起動する。重複起動は already-running として ok 扱い (Discord `/start` と同じ判断)。
  async start(gameId: string): Promise<StartResult> {
    const game = await getGame(this.env.GAME_REGISTRY, gameId);
    if (game === undefined) {
      return { ok: false, game_id: gameId, message: `unknown game: ${gameId}` };
    }
    if (!game.enabled) {
      return { ok: false, game_id: gameId, message: `game disabled: ${gameId}` };
    }

    const result = await runStartWorkflow(this.env, this.ctx, game);
    switch (result.status) {
      case 'started':
        return {
          ok: true,
          game_id: gameId,
          instance_id: result.instanceId,
          message: `starting (${result.fqdn}:${result.port})`,
        };
      case 'already-running':
        return {
          ok: true,
          game_id: gameId,
          instance_id: result.instanceId,
          message: `already ${result.state}`,
        };
      case 'failed':
        return { ok: false, game_id: gameId, message: result.error };
    }
  }

  // ゲームを停止する。既に停止済みは ok 扱い (idle 通知は web trigger では出ない)。
  async stop(gameId: string): Promise<StopResult> {
    const game = await getGame(this.env.GAME_REGISTRY, gameId);
    if (game === undefined) {
      return { ok: false, game_id: gameId, message: `unknown game: ${gameId}` };
    }

    const outcome = await runStopWorkflow(this.env, this.ctx, game, {
      triggeredBy: 'web',
    });
    switch (outcome.status) {
      case 'ok':
        return {
          ok: true,
          game_id: gameId,
          message:
            outcome.snapshotId !== undefined
              ? `stopped (snapshot ${outcome.snapshotId})`
              : 'stopped',
        };
      case 'already-stopped':
        return {
          ok: true,
          game_id: gameId,
          message: `already stopped (${outcome.reason})`,
        };
      case 'failed':
        return { ok: false, game_id: gameId, message: outcome.error };
    }
  }

  // ゲームの現在状態を返す。未登録は state=unknown。
  async status(gameId: string): Promise<StatusResult> {
    const game = await getGame(this.env.GAME_REGISTRY, gameId);
    if (game === undefined) {
      return { game_id: gameId, state: 'unknown', message: `unknown game: ${gameId}` };
    }
    return getGameStatus(this.env, this.ctx, game);
  }
}
