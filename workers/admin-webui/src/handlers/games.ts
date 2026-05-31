// game CRUD + ops ハンドラ (Phase 7)。
//   - GET    /admin/api/games            一覧 (KV scan)            [player]
//   - GET    /admin/api/games/:id        単体取得                  [player]
//   - PUT    /admin/api/games/:id        更新 (コスト fields は admin) [player]
//   - POST   /admin/api/games            新規追加                  [player]
//   - POST   /admin/api/games/:id/start  起動 (RPC 委譲)           [player]
//   - POST   /admin/api/games/:id/stop   停止 (RPC 委譲)           [player]
//   - GET    /admin/api/games/:id/status 状態 (RPC 委譲)           [player]
//
// B-0b では scaffold (501)。実装は B-3 (一覧/取得/更新) → D-2 (新規追加) → E-2 (ops)。
// コスト fields の enforcement は @gs/shared の resolveCostFields(form, tier) を使う (docs §5.3)。

import type { Env } from "../env.js";

export async function handleGamesApi(
  _request: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return new Response(
    JSON.stringify({ error: "not implemented (Phase 7 B-3/D-2/E-2)" }),
    { status: 501, headers: { "content-type": "application/json" } },
  );
}
