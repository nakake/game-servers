<script lang="ts">
  import { onMount } from "svelte";
  import type { GameDefinition } from "@gs/shared/registry-types";
  import { getGame } from "../lib/api";
  import { DUMMY_GAMES } from "../lib/dummy";
  import { navigate } from "../lib/router";

  // App.svelte が現在ルートの :id を渡す。
  export let gameId: string;

  let game: GameDefinition | null = null;
  let loading = true;
  let usingDummy = false;
  let notFound = false;

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    notFound = false;
    try {
      game = await getGame(gameId);
    } catch {
      // C-1: API 不在時は dummy から探す。詳細編集 UI 本体は C-2 で実装する。
      const found = DUMMY_GAMES.find((g) => g.game_id === gameId) ?? null;
      game = found;
      usingDummy = true;
      notFound = found === null;
    } finally {
      loading = false;
    }
  }

  function back(e: MouseEvent): void {
    e.preventDefault();
    navigate("/games");
  }
</script>

<a class="back" href="/games" on:click={back}>← 一覧へ</a>

{#if loading}
  <p class="muted">読み込み中…</p>
{:else if notFound || game === null}
  <p class="muted">ゲーム <code>{gameId}</code> は見つかりませんでした。</p>
{:else}
  {#if usingDummy}
    <div class="banner">ダミーデータ表示中 (C-1)。編集 UI は C-2 で実装します。</div>
  {/if}

  <h2>{game.display_name} <span class="muted">({game.game_id})</span></h2>

  <table class="kv">
    <tbody>
      <tr><th>カテゴリ</th><td>{game.category}</td></tr>
      <tr><th>状態</th><td>{game.enabled ? "enabled" : "disabled"}</td></tr>
      <tr><th>subdomain</th><td><code>{game.subdomain}</code></td></tr>
      <tr><th>CF_SLUG</th><td><code>{game.env["CF_SLUG"] ?? "—"}</code></td></tr>
      <tr><th>CF_FILE_ID</th><td><code>{game.env["CF_FILE_ID"] ?? "(latest)"}</code></td></tr>
      <tr><th>instance_types</th><td><code>{game.instance_types.join(", ")}</code></td></tr>
      <tr><th>ebs_size_gb</th><td>{game.ebs_size_gb}</td></tr>
      <tr><th>spot 上限 (¥/h)</th><td>{game.spot_max_price_jpy_per_hour ?? "—"}</td></tr>
    </tbody>
  </table>

  <h3>registry.json</h3>
  <div class="detail-json">{JSON.stringify(game, null, 2)}</div>
{/if}
