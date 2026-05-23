// メインループのコア — adapter.check の結果から「heartbeat を送る」「idle 通知を送る」を
// 決める状態機械。テストしやすいよう、ステートと判定を純粋関数に分けてある。
//
// 不変条件:
//   - adapter が失敗した tick (RCON 接続失敗等) は idle 判定の起点を更新する
//     (= 一時的なサーバ応答不能で誤発火しないように、安全側に倒す)。
//   - 一度 idle 通知を送ったら、`postNotifyCooldownMs` の間は再送しない (sidecar が
//     terminate される前のループでの二重発火回避)。

export interface LoopState {
  // 直近で player count > 0 だった時刻 (ms)。起動直後は loop 開始時刻で初期化する。
  lastNonIdleMs: number;
  // 直近で idle 通知を送った時刻 (ms)。0 = 未送信。
  lastNotifiedMs: number;
}

export interface LoopDecision {
  // heartbeat に送る player_count。adapter 失敗時は -1。
  heartbeatPlayerCount: number;
  // 今 tick で idle 通知を送るか。true なら state.lastNotifiedMs を呼び出し側が更新する。
  shouldNotifyIdle: boolean;
}

export interface TickInput {
  // adapter.check の結果。例外時は null を渡す (loop 側で catch)。
  result: { playerCount: number; idle: boolean } | null;
  // 現在時刻 (ms)。
  now: number;
  // registry の `idle_check.timeout_min * 60_000`。
  idleTimeoutMs: number;
  // 通知再送までの最小間隔 (ms)。
  postNotifyCooldownMs: number;
}

export function evaluateTick(state: LoopState, input: TickInput): LoopDecision {
  // 1) adapter 失敗時は state を保守的に「直近 non-idle」に更新し、heartbeat は -1 で送る。
  if (input.result === null) {
    state.lastNonIdleMs = input.now;
    return { heartbeatPlayerCount: -1, shouldNotifyIdle: false };
  }

  const { playerCount, idle } = input.result;

  // 2) player がいる / idle ではない → non-idle 時刻を更新。
  if (!idle) {
    state.lastNonIdleMs = input.now;
    return { heartbeatPlayerCount: playerCount, shouldNotifyIdle: false };
  }

  // 3) idle 状態。timeout を超えていなければ通知しない。
  const elapsedSinceNonIdle = input.now - state.lastNonIdleMs;
  if (elapsedSinceNonIdle <= input.idleTimeoutMs) {
    return { heartbeatPlayerCount: playerCount, shouldNotifyIdle: false };
  }

  // 4) idle で timeout 超過。直近 notify から cooldown を超えていれば送る。
  const elapsedSinceNotify = input.now - state.lastNotifiedMs;
  if (state.lastNotifiedMs !== 0 && elapsedSinceNotify < input.postNotifyCooldownMs) {
    return { heartbeatPlayerCount: playerCount, shouldNotifyIdle: false };
  }

  return { heartbeatPlayerCount: playerCount, shouldNotifyIdle: true };
}
