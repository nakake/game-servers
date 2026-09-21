// GAME_REGISTRY KV からゲーム定義 (registry.json) を読む。
//
// Phase 1 の lib/registry/atm11.ts (games/atm11/registry.json を build-time import) を
// 置き換える。KV のキー = game_id、値 = registry.json の JSON。投入は scripts/register-game.mjs。
//
// 一覧は SERVER_STATE の registry-index にキャッシュする (GAME_REGISTRY.list の消費削減)。
// index はキャッシュ扱いで、source of truth は GAME_REGISTRY のキーそのもの — 無い / 壊れて
// いれば list から作り直す (TTL 1 時間で必ず失効する)。
//
// KVNamespace を直接受け取るのは getGame だけ (Env 全体ではなく) — lib/state/pending-*.ts と
// 同じ流儀。listGames / rebuildRegistryIndex は Env の Pick を取る: 同型の namespace を 2 つ
// 位置引数で渡すと、取り違えても型で検出できないため。

import {
  REGISTRY_INDEX_KEY,
  REGISTRY_INDEX_TTL_SECONDS,
  parseRegistryIndex,
} from './registry-index.js';
import type { GameDefinition } from './types.js';
import type { Env } from '../../env.js';

// 1 ゲームを引く。未登録なら undefined。
export async function getGame(
  kv: KVNamespace,
  gameId: string,
): Promise<GameDefinition | undefined> {
  const game = await kv.get<GameDefinition>(gameId, 'json');
  return game ?? undefined;
}

// 登録済み全ゲーム。registry-index の id を順に get する (index が無い / 壊れている / 空なら
// rebuildRegistryIndex で list から作り直す)。KV list はキー名昇順で返す。ゲーム数は小規模で、
// list の 1000 件上限・ページネーションには当たらない前提 (超えたら cursor 対応が要る)。
export async function listGames(
  env: Pick<Env, 'GAME_REGISTRY' | 'SERVER_STATE'>,
): Promise<GameDefinition[]> {
  let ids: string[] | undefined;
  try {
    ids = parseRegistryIndex(await env.SERVER_STATE.get(REGISTRY_INDEX_KEY, 'json'));
  } catch {
    // get の throw (一過性の KV 障害) は miss 扱い — list から作り直せば同じ結果になる。
    ids = undefined;
  }
  if (ids === undefined) ids = await rebuildRegistryIndex(env);

  const games = await Promise.all(
    ids.map((id) => env.GAME_REGISTRY.get<GameDefinition>(id, 'json')),
  );
  return games.filter((g): g is GameDefinition => g !== null);
}

// GAME_REGISTRY.list から index を作り直し、SERVER_STATE に put して id 配列を返す。
// extraIds は「put 直後の list が結果整合で新キーを含まない」場合への備え (登録側が渡す)。
export async function rebuildRegistryIndex(
  env: Pick<Env, 'GAME_REGISTRY' | 'SERVER_STATE'>,
  extraIds: readonly string[] = [],
): Promise<string[]> {
  const { keys } = await env.GAME_REGISTRY.list();
  const ids = [...new Set([...keys.map((k) => k.name), ...extraIds])].sort();

  // 0 件のときは put しない — list の一時的な異常で空の index を 1 時間固定すると、
  // idle-fallback が全ゲームを見失うため。
  if (ids.length > 0) {
    try {
      await env.SERVER_STATE.put(REGISTRY_INDEX_KEY, JSON.stringify(ids), {
        expirationTtl: REGISTRY_INDEX_TTL_SECONDS,
      });
    } catch (err) {
      // 同一 tick で retention と idle-fallback が同時に miss すると、KV の「1 キー 1 秒
      // 1 書き込み」制限で片方の put が失敗する。index が無くても次回 list から作り直せる
      // ため、credentials.ts の writeCache と同じく warn だけで握りつぶす。
      console.warn('registry-index put failed:', err);
    }
  }
  return ids;
}

// heartbeat を打ってきたゲームを index に載せておく (idle-fallback の自己修復)。
//
// idle-fallback が強制停止できるのは最後の heartbeat から timeout_min+5 分 〜 last-seen の
// TTL (timeout_min*3 分) の間だけ。この窓の間に index に無いと last-seen が先に失効し、以後は
// no-heartbeat で skip され続けて EC2 が止まらなくなる。index が無い場合は何もしない — 次の
// listGames が list から作り直し、GAME_REGISTRY のキーは既に存在するので必ず含まれる。
//
// heartbeat の応答を失敗させないため、全体を try/catch で囲み warn だけで握りつぶす。
export async function ensureGameIndexed(
  env: Pick<Env, 'GAME_REGISTRY' | 'SERVER_STATE'>,
  gameId: string,
): Promise<void> {
  try {
    const ids = parseRegistryIndex(await env.SERVER_STATE.get(REGISTRY_INDEX_KEY, 'json'));
    if (ids === undefined || ids.includes(gameId)) return;
    await rebuildRegistryIndex(env, [gameId]);
  } catch (err) {
    console.warn('ensureGameIndexed failed:', err);
  }
}
