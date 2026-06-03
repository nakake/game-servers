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
//
// start/stop は数分かかる (EC2 running 待ち最大 240s 等) ので、Discord `/start` ハンドラと
// 同じく `this.ctx.waitUntil` で後追いし即時返す。高速な検証 (game 存在 / enabled) だけ同期で
// 行い、呼び出し側 (admin-webui) は即フィードバックを得て、完了は status polling で確認する。
// waitUntil タスクは request ツリー全体 (caller の応答後) まで生かされる。

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
  // ゲームの起動を受け付ける。検証のみ同期で行い、起動本体は waitUntil で後追いする。
  // 完了 (running + DNS) は呼び出し側が status polling で確認する。
  async start(gameId: string): Promise<StartResult> {
    const game = await getGame(this.env.GAME_REGISTRY, gameId);
    if (game === undefined) {
      return { ok: false, game_id: gameId, message: `unknown game: ${gameId}` };
    }
    if (!game.enabled) {
      return { ok: false, game_id: gameId, message: `game disabled: ${gameId}` };
    }

    this.ctx.waitUntil(
      runStartWorkflow(this.env, this.ctx, game).then((result) => {
        if (result.status === 'failed') {
          console.error(`[rpc] start ${gameId} failed: ${result.error}`);
        } else {
          console.log(`[rpc] start ${gameId}: ${result.status}`);
        }
      }),
    );
    return { ok: true, game_id: gameId, message: 'starting' };
  }

  // ゲームの停止を受け付ける。検証のみ同期で行い、停止本体は waitUntil で後追いする。
  // 既に停止済み等の判定は workflow 内 (idle 通知は web trigger では出ない)。
  async stop(gameId: string): Promise<StopResult> {
    const game = await getGame(this.env.GAME_REGISTRY, gameId);
    if (game === undefined) {
      return { ok: false, game_id: gameId, message: `unknown game: ${gameId}` };
    }

    this.ctx.waitUntil(
      runStopWorkflow(this.env, this.ctx, game, { triggeredBy: 'web' }).then(
        (outcome) => {
          if (outcome.status === 'failed') {
            console.error(`[rpc] stop ${gameId} failed: ${outcome.error}`);
          } else {
            console.log(`[rpc] stop ${gameId}: ${outcome.status}`);
          }
        },
      ),
    );
    return { ok: true, game_id: gameId, message: 'stopping' };
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
