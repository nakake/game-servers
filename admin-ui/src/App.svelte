<script lang="ts">
  import { route, navigate } from "./lib/router";
  import Games from "./routes/Games.svelte";
  import GameDetail from "./routes/GameDetail.svelte";

  function goHome(e: MouseEvent): void {
    e.preventDefault();
    navigate("/games");
  }
</script>

<header class="app-header">
  <h1><a href="/games" on:click={goHome}>gs-admin</a></h1>
  <span class="sub">modpack 管理</span>
</header>

<main>
  {#if $route.gameId !== null}
    <GameDetail gameId={$route.gameId} />
  {:else}
    <Games />
  {/if}
</main>
