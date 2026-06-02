<script lang="ts">
  import type { GameDefinition, Tier } from "@gs/shared/registry-types";
  import { applyGameUpdate } from "@gs/shared/build";
  import { getGame, updateGame, ApiError } from "../lib/api";
  import { DUMMY_GAMES } from "../lib/dummy";
  import { navigate } from "../lib/router";
  import { session } from "../lib/session";

  // App.svelte が現在ルートの :id を渡す。
  export let gameId: string;

  let game: GameDefinition | null = null;
  let loading = true;
  // GET が失敗し dummy にフォールバックしているか (保存も local 反映に切り替える)。
  let gameDummy = false;
  let notFound = false;
  let loadError: string | null = null;

  let saving = false;
  let saveMsg: string | null = null;
  let saveErr: string | null = null;

  // フォーム状態 (すべて文字列で持ち、保存時にパースする)。
  let cfFileId = "";
  let version = "";
  let memory = "";
  let instanceTypesStr = "";
  let ebsSizeGbStr = "";
  let spotMaxPriceStr = "";

  // tier は session store から。未ロード時は player 扱い (= コスト field を隠す安全側)。
  $: tier = $session?.tier ?? "player";
  $: isAdmin = tier === "admin";

  // modpack (AUTO_CURSEFORGE) は Minecraft / loader バージョンが modpack 側で固定される。
  // その場合バージョンの knob は CF_FILE_ID で、VERSION (MC バージョン) は read-only にする
  // (docs §1.1: modpack バージョン更新 = CF_FILE_ID)。vanilla 等のみ VERSION を直接編集できる。
  $: isModpack =
    game !== null &&
    (game.env["MODPACK_PLATFORM"] === "AUTO_CURSEFORGE" ||
      (game.env["CF_SLUG"] ?? "") !== "");

  // gameId が変わったら (一覧→別ゲーム) 再ロードする。onMount 代わりの reactive ガード。
  let loadedId: string | null = null;
  $: if (gameId !== loadedId) {
    loadedId = gameId;
    void load();
  }

  async function load(): Promise<void> {
    loading = true;
    notFound = false;
    gameDummy = false;
    loadError = null;
    saveMsg = null;
    saveErr = null;
    try {
      game = await getGame(gameId);
    } catch (e) {
      if (e instanceof ApiError) {
        // サーバ応答あり。dummy は出さない。
        game = null;
        if (e.status === 404) {
          notFound = true;
        } else {
          loadError =
            e.status === 401
              ? "セッションが切れました。Discord で /panel を実行して入り直してください。"
              : `読み込みに失敗しました (HTTP ${e.status})`;
        }
      } else {
        // fetch 失敗 = バックエンド不在 (vite dev 単体) のみ dummy (docs §10.1)。
        const found = DUMMY_GAMES.find((g) => g.game_id === gameId) ?? null;
        game = found;
        gameDummy = true;
        notFound = found === null;
      }
    } finally {
      loading = false;
      if (game !== null) initForm(game);
    }
  }

  function initForm(g: GameDefinition): void {
    cfFileId = g.env["CF_FILE_ID"] ?? "";
    version = g.env["VERSION"] ?? "";
    memory = g.env["MEMORY"] ?? "";
    instanceTypesStr = g.instance_types.join(", ");
    ebsSizeGbStr = String(g.ebs_size_gb);
    spotMaxPriceStr =
      g.spot_max_price_jpy_per_hour === null
        ? ""
        : String(g.spot_max_price_jpy_per_hour);
  }

  function parseInstanceTypes(): string[] {
    return instanceTypesStr
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function validate(t: Tier): string | null {
    if (t === "admin") {
      const ebs = Number(ebsSizeGbStr);
      if (!Number.isInteger(ebs) || ebs <= 0) {
        return "ebs_size_gb は正の整数で入力してください";
      }
      if (spotMaxPriceStr.trim() !== "") {
        const sp = Number(spotMaxPriceStr);
        if (!Number.isFinite(sp) || sp < 0) {
          return "spot 上限は 0 以上の数値か、空 (= 上限なし) で入力してください";
        }
      }
      if (parseInstanceTypes().length === 0) {
        return "instance_types を 1 つ以上入力してください";
      }
    }
    return null;
  }

  // tier に応じた部分更新を組み立てる。コスト系 field は admin のときだけ含める
  // (player が送ってもサーバ側 applyGameUpdate が無視するが、UI でも送らない)。
  function buildPatch(t: Tier): Partial<GameDefinition> {
    const env: Record<string, string> = {};
    if (isModpack) {
      // modpack はバージョンの実体が CF_FILE_ID。MC VERSION は pack により固定なので触らない。
      env.CF_FILE_ID = cfFileId.trim();
    } else {
      // vanilla 等は VERSION が唯一のバージョン knob (CF_FILE_ID は持たない)。
      env.VERSION = version.trim();
    }
    const patch: Partial<GameDefinition> = { env };
    if (t === "admin") {
      env.MEMORY = memory.trim();
      patch.instance_types = parseInstanceTypes();
      patch.ebs_size_gb = Number(ebsSizeGbStr);
      patch.spot_max_price_jpy_per_hour =
        spotMaxPriceStr.trim() === "" ? null : Number(spotMaxPriceStr);
    }
    return patch;
  }

  async function save(): Promise<void> {
    if (game === null) return;
    saveErr = null;
    saveMsg = null;
    const t = tier;
    const err = validate(t);
    if (err !== null) {
      saveErr = err;
      return;
    }
    const patch = buildPatch(t);
    saving = true;
    try {
      game = await updateGame(gameId, patch);
      saveMsg = "保存しました";
    } catch (e) {
      if (gameDummy) {
        // オフライン demo: サーバと同じ enforcement を local に適用する。
        game = applyGameUpdate(game, patch, t);
        saveMsg = "(ダミー) ローカルに反映しました";
      } else {
        saveErr =
          e instanceof ApiError
            ? `保存に失敗しました (HTTP ${e.status})`
            : "保存に失敗しました";
      }
    } finally {
      saving = false;
      if (game !== null) initForm(game);
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
{:else if loadError}
  <p class="muted">{loadError}</p>
{:else if notFound || game === null}
  <p class="muted">ゲーム <code>{gameId}</code> は見つかりませんでした。</p>
{:else}
  {#if gameDummy}
    <div class="banner">
      ダミーデータを編集中 (C-2)。保存はローカルにのみ反映され、実 KV には書き込まれません。
    </div>
  {/if}

  <h2>{game.display_name} <span class="muted">({game.game_id})</span></h2>

  <form on:submit|preventDefault={save}>
    <fieldset>
      <legend>バージョン</legend>
      {#if isModpack}
        <div class="ro-field">
          <span>CF_SLUG</span>
          <code>{game.env["CF_SLUG"] ?? "—"}</code>
        </div>
        <label>
          <span>
            modpack バージョン <span class="muted">(CF_FILE_ID、空 = latest)</span>
          </span>
          <input
            type="text"
            inputmode="numeric"
            bind:value={cfFileId}
            placeholder="(latest)"
          />
        </label>
        <div class="ro-field">
          <span>
            Minecraft バージョン <span class="muted">(modpack により固定)</span>
          </span>
          <code>{version || "—"}</code>
        </div>
      {:else}
        <label>
          <span>Minecraft バージョン <span class="muted">(VERSION)</span></span>
          <input type="text" bind:value={version} placeholder="1.21.1" />
        </label>
      {/if}
    </fieldset>

    {#if isAdmin}
      <fieldset>
        <legend>コスト・サイズ <span class="muted">(admin のみ)</span></legend>
        <label>
          <span>MEMORY <span class="muted">(例: 10G、空可)</span></span>
          <input type="text" bind:value={memory} placeholder="(image 既定)" />
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
          <span>ebs_size_gb</span>
          <input type="text" inputmode="numeric" bind:value={ebsSizeGbStr} />
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
        コスト・サイズ系 (instance_types / ebs_size_gb / spot 上限 / MEMORY) は
        admin のみ編集できます。
      </p>
    {/if}

    <div class="actions">
      <button type="submit" disabled={saving}>
        {saving ? "保存中…" : "保存"}
      </button>
      {#if saveMsg}<span class="ok-msg">{saveMsg}</span>{/if}
      {#if saveErr}<span class="err-msg">{saveErr}</span>{/if}
    </div>
  </form>

  <h3>registry.json</h3>
  <div class="detail-json">{JSON.stringify(game, null, 2)}</div>
{/if}
