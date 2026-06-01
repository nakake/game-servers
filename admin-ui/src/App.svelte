<script lang="ts">
  import { onMount } from "svelte";
  import { route, navigate } from "./lib/router";
  import { session, loadSession, previewTier } from "./lib/session";
  import Games from "./routes/Games.svelte";
  import GameDetail from "./routes/GameDetail.svelte";

  onMount(loadSession);

  function goHome(e: MouseEvent): void {
    e.preventDefault();
    navigate("/games");
  }
</script>

<header class="app-header">
  <h1><a href="/games" on:click={goHome}>gs-admin</a></h1>
  <span class="sub">modpack 管理</span>
  <span class="spacer" />
  {#if $session !== null}
    <span class="pill {$session.tier === 'admin' ? 'on' : ''}">{$session.tier}</span>
    {#if $session.usingDummy}
      <span class="dummy-toggle">
        <button
          class:active={$session.tier === "admin"}
          on:click={() => previewTier("admin")}>admin</button
        >
        <button
          class:active={$session.tier === "player"}
          on:click={() => previewTier("player")}>player</button
        >
      </span>
    {/if}
  {/if}
</header>

<main>
  {#if $route.gameId !== null}
    <GameDetail gameId={$route.gameId} />
  {:else}
    <Games />
  {/if}
</main>
