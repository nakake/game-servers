// admin-ui (SPA) の Vite 設定。
//
// build 出力は admin-webui Worker の [assets] が配信する public/ に直接吐く (docs §7.2)。
// CI 不在のため admin-webui/wrangler.toml の [build] が deploy 時にこの build を走らせ、
// 空/古い public/ の deploy 事故を防ぐ (docs §11.7)。
//
// dev サーバは /admin/api と /auth を wrangler dev (localhost:8787) へ proxy する。
// wrangler を起動していなければ proxy は失敗し、各画面は dummy データに fallback する
// (C-1 の「ダミーデータで動作」、docs §10.1)。
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: "../workers/admin-webui/public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/admin/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
    },
  },
});
