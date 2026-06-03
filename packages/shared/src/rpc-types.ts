// discord-handler が export する InternalRpc (WorkerEntrypoint) の引数・戻り値型 + メソッド契約。
// admin-webui は Service Binding 経由でこれらを呼ぶ (ADR 0004 / docs §6.1)。
//
// AWS ロジックそのものは discord-handler 内に閉じ、ここには契約 (型) だけを置く。
// E-1 で実 RPC (start/stop/status) と整合済み。s3Sync は不採用 — Worker にローカル config が
// 無く実 sync 不可で、AUTO_CURSEFORGE は boot 時に CF 取得するため新規追加でも S3 sync 不要。

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

// InternalRpc (discord-handler の WorkerEntrypoint) のメソッド契約。
// - discord-handler の InternalRpc class はこれを implements して契約を compile time に固定する。
// - admin-webui は Service Binding を `Service<InternalRpcInterface>` で型付けする (E-2)。
export interface InternalRpcInterface {
  start(gameId: string): Promise<StartResult>;
  stop(gameId: string): Promise<StopResult>;
  status(gameId: string): Promise<StatusResult>;
}
