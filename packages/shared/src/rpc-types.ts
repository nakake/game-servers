// discord-handler が export する InternalRpc (WorkerEntrypoint) の引数・戻り値型。
// admin-webui は Service Binding 経由でこれらを呼ぶ (ADR 0004 / docs §6.1)。
//
// AWS ロジックそのものは discord-handler 内に閉じ、ここには契約 (型) だけを置く。
// B-0a では骨組み。実 RPC メソッド実装との整合・詳細化は Phase 7 E-1 で行う。

// EC2 / インスタンスのライフサイクル状態 (status RPC の戻り)。
export type ServerState =
  | "running"
  | "pending"
  | "stopping"
  | "stopped"
  | "unknown";

export interface StartResult {
  ok: boolean;
  game_id: string;
  instance_id?: string;
  message?: string;
}

export interface StopResult {
  ok: boolean;
  game_id: string;
  message?: string;
}

export interface StatusResult {
  game_id: string;
  state: ServerState;
  instance_id?: string;
  // 起動済みの場合の接続先 (例: atm10.example.com)。
  endpoint?: string;
  message?: string;
}
