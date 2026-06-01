// vite-plugin-svelte / svelte-check が共通で読む preprocess 設定。
// <script lang="ts"> を扱うために vitePreprocess を使う (SvelteKit ではなく素の Svelte)。
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
};
