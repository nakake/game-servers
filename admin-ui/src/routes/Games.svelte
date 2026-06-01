<script lang="ts">
  import { onMount } from "svelte";
  import type { GameDefinition } from "@gs/shared/registry-types";
  import { listGames } from "../lib/api";
  import { DUMMY_GAMES } from "../lib/dummy";
  import { navigate } from "../lib/router";

  let games: GameDefinition[] = [];
  let loading = true;
  let usingDummy = false;

  onMount(async () => {
    try {
      games = await listGames();
    } catch {
      // バックエンド不在 (vite dev 単体) / 未デプロイ時は dummy に fallback (docs §10.1 C-1)。
      games = DUMMY_GAMES;
      usingDummy = true;
    } finally {
      loading = false;
    }
  });

  function cfFileId(g: GameDefinition): string {
    return g.env["CF_FILE_ID"] ?? "(latest)";
  }

  function portList(g: GameDefinition): string {
    return g.ports.map((p) => `${p.port}/${p.proto}`).join(", ");
  }

  function open(id: string): void {
    navigate(`/games/${encodeURIComponent(id)}`);
  }
</script>

<h2>ゲーム一覧</h2>

{#if usingDummy}
  <div class="banner">
    API に接続できないためダミーデータを表示しています (C-1)。実データは admin-webui
    デプロイ後に表示されます。
  </div>
{/if}

{#if loading}
  <p class="muted">読み込み中…</p>
{:else if games.length === 0}
  <p class="muted">登録されているゲームはありません。</p>
{:else}
  <table>
    <thead>
      <tr>
        <th>ゲーム</th>
        <th>game_id</th>
        <th>カテゴリ</th>
        <th>CF_FILE_ID</th>
        <th>ポート</th>
        <th>状態</th>
      </tr>
    </thead>
    <tbody>
      {#each games as g (g.game_id)}
        <tr on:click={() => open(g.game_id)}>
          <td>{g.display_name}</td>
          <td><code>{g.game_id}</code></td>
          <td class="muted">{g.category}</td>
          <td><code>{cfFileId(g)}</code></td>
          <td class="muted">{portList(g)}</td>
          <td>
            {#if g.enabled}
              <span class="pill on">enabled</span>
            {:else}
              <span class="pill off">disabled</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
