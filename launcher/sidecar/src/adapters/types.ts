// Idle 検知アダプタの共通インターフェース。
//
// design.md §3.3「idle 検知アダプタ」で定義された category 別の判定方法を、sidecar 内の
// 個別実装に閉じる契約。`idle_check.type` で adapter を選び、`config` と `password` を渡す。

export interface IdleAdapterContext {
  // registry の `idle_check.config` をそのまま渡す。各 adapter が必要なキー (host / port / command 等)
  // を取り出す。schema は緩めに保ち、adapter 側で型検査する。
  config: Record<string, unknown>;
  // RCON / 認証付き API の場合に SSM から取り出した秘密 (例: minecraft_rcon の password)。
  // 不要なら空文字を渡す。
  password: string;
}

export interface AdapterCheckResult {
  // 観測した player count。adapter が値を取得できなかった場合は -1。
  playerCount: number;
  // idle (= player_count == 0 と思われる) 判定。`playerCount === 0` よりも adapter が解釈した
  // 「player がいない」を優先する (`empty_pattern` での detection 等)。
  idle: boolean;
}

export interface IdleAdapter {
  check(ctx: IdleAdapterContext): Promise<AdapterCheckResult>;
}
