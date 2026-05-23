import { defineConfig } from 'vitest/config';

// Phase 3 で導入 (docs/phase3-plan.md 決定9)。
//
// HMAC ヘルパや handler の単体テストを Node 環境で動かす最小設定。
// Workers 固有 API は polyfill せず、Web Crypto / TextEncoder / atob/btoa など
// Node 22 と Workers のどちらでも同じ挙動になる範囲だけをテスト対象にする。
// fetch ハンドラ全体の統合テストが要るようになったら @cloudflare/vitest-pool-workers を
// 検討する (Phase 3 時点ではオーバースペック)。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
