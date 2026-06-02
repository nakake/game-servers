<script lang="ts">
  import type { ModLoader } from "@gs/shared/registry-types";
  import type { ModpackFile, ModpackSummary } from "@gs/shared/modpack-types";
  import { deriveModpackMeta } from "@gs/shared/modpack-types";
  import {
    searchModpacks,
    getModpackBySlug,
    createGame,
    ApiError,
  } from "../lib/api";
  import { navigate } from "../lib/router";
  import { session } from "../lib/session";

  $: tier = $session?.tier ?? "player";
  $: isAdmin = tier === "admin";
  // バックエンド不在 (vite dev 単体) では CF proxy が無く検索できない。
  $: offline = $session?.usingDummy ?? false;

  // ---- 検索 ----
  let keyword = "";
  let searching = false;
  let searchErr: string | null = null;
  let results: ModpackSummary[] = [];
  let searched = false;

  async function runSearch(): Promise<void> {
    const q = keyword.trim();
    if (q === "") return;
    searching = true;
    searchErr = null;
    searched = true;
    try {
      results = await searchModpacks(q);
    } catch (e) {
      results = [];
      searchErr = offline
        ? "ローカル開発ではバックエンド (CF proxy) が無いため検索できません。"
        : e instanceof ApiError
          ? `検索に失敗しました (HTTP ${e.status})`
          : "検索に失敗しました (バックエンド未接続)";
    } finally {
      searching = false;
    }
  }

  // ---- 選択 + 版一覧 ----
  let selected: ModpackSummary | null = null;
  let files: ModpackFile[] = [];
  let loadingFiles = false;

  // ---- フォーム (すべて文字列で保持、送信時にパース) ----
  let gameId = "";
  let displayName = "";
  let subdomain = "";
  let selectedFileId = ""; // "" = latest
  let minecraftVersion = "";
  let modLoader: ModLoader = "NEOFORGE";
  let portStr = "25565";
  // admin のみ。空なら送らず、サーバ既定 (COST_FIELD_DEFAULTS) に委ねる。
  let memoryGbStr = "";
  let instanceTypesStr = "";
  let ebsSizeGbStr = "";
  let spotMaxPriceStr = "";

  let creating = false;
  let createErr: string | null = null;

  async function select(s: ModpackSummary): Promise<void> {
    selected = s;
    files = [];
    loadingFiles = true;
    createErr = null;
    // フォーム既定値。
    gameId = s.slug;
    displayName = s.name;
    subdomain = s.slug;
    selectedFileId = "";
    minecraftVersion = "";
    modLoader = "NEOFORGE";
    portStr = "25565";
    try {
      const detail = await getModpackBySlug(s.slug);
      files = detail.files;
      deriveFor(""); // latest (= files[0]) からメタ既定値を入れる
    } catch (e) {
      createErr =
        e instanceof ApiError
          ? `版一覧の取得に失敗しました (HTTP ${e.status})`
          : "版一覧の取得に失敗しました";
    } finally {
      loadingFiles = false;
    }
  }

  // 選択中の版 (latest なら files[0]) の gameVersions から MC 版 / loader を推定して埋める。
  // 版の選び直しは「派生メタを引き直す」明示操作とみなし上書きする (利用者は後から補正可)。
  function deriveFor(fileId: string): void {
    const f =
      fileId === ""
        ? files[0]
        : files.find((x) => String(x.fileId) === fileId);
    const meta = f
      ? deriveModpackMeta(f.gameVersions)
      : { minecraftVersion: null, modLoader: null };
    minecraftVersion = meta.minecraftVersion ?? "";
    modLoader = meta.modLoader ?? "NEOFORGE";
  }

  function onFileChange(): void {
    deriveFor(selectedFileId);
  }

  function clearSelection(): void {
    selected = null;
    files = [];
    createErr = null;
  }

  function fileLabel(f: ModpackFile): string {
    const ch = f.releaseType === 1 ? "release" : f.releaseType === 2 ? "beta" : "alpha";
    return `${f.displayName} · ${ch} · ${f.gameVersions.join("/")}`;
  }

  const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

  function parseInstanceTypes(): string[] {
    return instanceTypesStr
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function validate(): string | null {
    if (!KEBAB.test(gameId.trim())) {
      return "game_id は英小文字始まりの kebab-case で入力してください";
    }
    if (displayName.trim() === "") return "display_name を入力してください";
    if (subdomain.trim() !== "" && !KEBAB.test(subdomain.trim())) {
      return "subdomain は kebab-case で入力してください";
    }
    if (minecraftVersion.trim() === "") {
      return "Minecraft バージョンを入力してください";
    }
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return "port は 1〜65535 の整数で入力してください";
    }
    if (isAdmin) {
      if (memoryGbStr.trim() !== "") {
        const m = Number(memoryGbStr);
        if (!Number.isInteger(m) || m <= 0) return "MEMORY(GB) は正の整数で";
      }
      if (ebsSizeGbStr.trim() !== "") {
        const e = Number(ebsSizeGbStr);
        if (!Number.isInteger(e) || e <= 0) return "ebs_size_gb は正の整数で";
      }
      if (spotMaxPriceStr.trim() !== "") {
        const sp = Number(spotMaxPriceStr);
        if (!Number.isFinite(sp) || sp <= 0) {
          return "spot 上限は正の数値か、空 (= 上限なし) で入力してください";
        }
      }
    }
    return null;
  }

  function buildBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      game_id: gameId.trim(),
      display_name: displayName.trim(),
      subdomain: subdomain.trim() || gameId.trim(),
      cf_slug: selected!.slug,
      cf_modpack_meta: {
        modId: selected!.modId,
        minecraftVersion: minecraftVersion.trim(),
        modLoader,
      },
      port: Number(portStr),
    };
    if (selectedFileId !== "") body.cf_file_id = Number(selectedFileId);
    // admin が値を入れた cost field のみ送る (未入力はサーバ既定に委ねる)。
    if (isAdmin) {
      if (memoryGbStr.trim() !== "") body.memory_gb = Number(memoryGbStr);
      const its = parseInstanceTypes();
      if (its.length > 0) body.instance_types = its;
      if (ebsSizeGbStr.trim() !== "") body.ebs_size_gb = Number(ebsSizeGbStr);
      if (spotMaxPriceStr.trim() !== "") {
        body.spot_max_price_jpy_per_hour = Number(spotMaxPriceStr);
      }
    }
    return body;
  }

  async function submit(): Promise<void> {
    if (selected === null) return;
    createErr = null;
    const err = validate();
    if (err !== null) {
      createErr = err;
      return;
    }
    creating = true;
    try {
      const game = await createGame(buildBody());
      navigate(`/games/${encodeURIComponent(game.game_id)}`);
    } catch (e) {
      if (e instanceof ApiError) {
        createErr =
          e.status === 409
            ? `game_id "${gameId.trim()}" は既に存在します`
            : e.status === 400
              ? "入力内容が不正です (サーバ検証で却下)"
              : `追加に失敗しました (HTTP ${e.status})`;
      } else {
        createErr = "追加に失敗しました (バックエンド未接続)";
      }
    } finally {
      creating = false;
    }
  }

  function back(e: MouseEvent): void {
    e.preventDefault();
    navigate("/games");
  }
</script>

<a class="back" href="/games" on:click={back}>← 一覧へ</a>

<h2>新規ゲーム追加</h2>

{#if offline}
  <div class="banner">
    ローカル開発 (バックエンド未接続) では modpack 検索・追加は利用できません。
    本番 (ログイン済) で操作してください。
  </div>
{/if}

<!-- ステップ 1: modpack 検索 -->
<fieldset>
  <legend>1. modpack を検索 <span class="muted">(CurseForge)</span></legend>
  <form class="search-row" on:submit|preventDefault={runSearch}>
    <input
      type="text"
      bind:value={keyword}
      placeholder="modpack 名で検索 (例: All the Mods)"
    />
    <button type="submit" disabled={searching || keyword.trim() === ""}>
      {searching ? "検索中…" : "検索"}
    </button>
  </form>

  {#if searchErr}
    <p class="err-msg">{searchErr}</p>
  {:else if searched && !searching && results.length === 0}
    <p class="muted">該当する modpack が見つかりませんでした。</p>
  {:else if results.length > 0}
    <ul class="results">
      {#each results as r (r.modId)}
        <li class:selected={selected?.modId === r.modId}>
          <button type="button" on:click={() => select(r)}>
            {#if r.thumbnailUrl}
              <img src={r.thumbnailUrl} alt="" width="40" height="40" />
            {/if}
            <span class="r-body">
              <span class="r-name">{r.name}</span>
              <span class="r-slug muted"><code>{r.slug}</code></span>
              <span class="r-sum muted">{r.summary}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</fieldset>

<!-- ステップ 2: 選択 → フォーム -->
{#if selected !== null}
  <h3>
    2. <code>{selected.slug}</code> を追加
    <button type="button" class="link-btn" on:click={clearSelection}>(選び直す)</button>
  </h3>

  <form on:submit|preventDefault={submit}>
    <fieldset>
      <legend>基本</legend>
      <label>
        <span>game_id <span class="muted">(英小文字 kebab、一意)</span></span>
        <input type="text" bind:value={gameId} placeholder="all-the-mods-10" />
      </label>
      <label>
        <span>display_name</span>
        <input type="text" bind:value={displayName} />
      </label>
      <label>
        <span>subdomain <span class="muted">(空なら game_id と同じ)</span></span>
        <input type="text" bind:value={subdomain} placeholder={gameId} />
      </label>
      <label>
        <span>port</span>
        <input type="text" inputmode="numeric" bind:value={portStr} />
      </label>
    </fieldset>

    <fieldset>
      <legend>バージョン</legend>
      {#if loadingFiles}
        <p class="muted">版一覧を取得中…</p>
      {/if}
      <label>
        <span>
          modpack バージョン <span class="muted">(CF_FILE_ID、未選択 = latest)</span>
        </span>
        <select bind:value={selectedFileId} on:change={onFileChange}>
          <option value="">(latest)</option>
          {#each files as f (f.fileId)}
            <option value={String(f.fileId)}>{fileLabel(f)}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Minecraft バージョン <span class="muted">(版から推定、補正可)</span></span>
        <input type="text" bind:value={minecraftVersion} placeholder="1.21.1" />
      </label>
      <label>
        <span>mod loader <span class="muted">(版から推定、補正可)</span></span>
        <select bind:value={modLoader}>
          <option value="NEOFORGE">NeoForge</option>
          <option value="FORGE">Forge</option>
          <option value="FABRIC">Fabric</option>
          <option value="QUILT">Quilt</option>
        </select>
      </label>
    </fieldset>

    {#if isAdmin}
      <fieldset>
        <legend>コスト・サイズ <span class="muted">(admin のみ・空欄は既定値)</span></legend>
        <label>
          <span>MEMORY (GB) <span class="muted">(既定 8)</span></span>
          <input type="text" inputmode="numeric" bind:value={memoryGbStr} placeholder="8" />
        </label>
        <label>
          <span>instance_types <span class="muted">(カンマ区切り)</span></span>
          <input
            type="text"
            bind:value={instanceTypesStr}
            placeholder="r7a.large, r6a.large"
          />
        </label>
        <label>
          <span>ebs_size_gb <span class="muted">(既定 30)</span></span>
          <input type="text" inputmode="numeric" bind:value={ebsSizeGbStr} placeholder="30" />
        </label>
        <label>
          <span>spot 上限 <span class="muted">(¥/h、空 = 上限なし)</span></span>
          <input
            type="text"
            inputmode="numeric"
            bind:value={spotMaxPriceStr}
            placeholder="(上限なし)"
          />
        </label>
      </fieldset>
    {:else}
      <p class="muted note">
        コスト・サイズ系は admin が既定値で作成します (player は変更不可)。
      </p>
    {/if}

    <p class="muted note">
      ※ 追加直後の初回起動には rcon パスワード等の準備が別途必要になる場合があります。
    </p>

    <div class="actions">
      <button type="submit" disabled={creating || loadingFiles}>
        {creating ? "追加中…" : "このゲームを追加"}
      </button>
      {#if createErr}<span class="err-msg">{createErr}</span>{/if}
    </div>
  </form>
{/if}
