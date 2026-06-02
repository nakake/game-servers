<script lang="ts">
  import { onMount } from "svelte";
  import { route, navigate } from "./lib/router";
  import { session, loadSession, previewTier } from "./lib/session";
  import Games from "./routes/Games.svelte";
  import GameDetail from "./routes/GameDetail.svelte";
  import NewGame from "./routes/NewGame.svelte";

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
  {#if $session !== null && $session.authed}
    <span class="pill {$session.tier === 'admin' ? 'on' : ''}">{$session.tier}</span
    >
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
  {#if $session === null}
    <p class="muted">読み込み中…</p>
  {:else if !$session.authed}
    <div class="login-required">
      <h2>ログインが必要です</h2>
      <p class="muted">
        この画面は管理者・プレイヤー専用です。Discord で <code>/panel</code>
        を実行し、表示されたリンク（自分だけに見える）から入り直してください。
      </p>
      <p class="muted">リンクは発行から 5 分間・1 回のみ有効です。</p>
    </div>
  {:else if $route.isNew}
    <NewGame />
  {:else if $route.gameId !== null}
    <GameDetail gameId={$route.gameId} />
  {:else}
    <Games />
  {/if}
</main>
