// games/<id>/registry.json のスキーマ型定義 (design.md §3.1)。
//
// Phase 7 (B-0a) で型本体を共有パッケージ @gs/shared に移設した。ここは後方互換のための
// re-export のみ — 既存の `from '.../registry/types.js'` import をそのまま生かす。
// 新規コードは `@gs/shared` から直接 import してよい。
// 移設理由: admin-webui Worker と register-game.mjs が同じ registry スキーマ型を要するため
// (ADR 0004 / docs/phase7-modpack-webui.md §7.2)。

export type { GameCategory, GameDefinition } from "@gs/shared/registry-types";
