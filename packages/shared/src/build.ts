// NewGameForm → GameDefinition 変換と、コスト系 field の tier 別解決。
//
// ADR 0004: このパッケージには AWS / OIDC ロジックを入れない (鍵隔離)。純粋変換のみ。
// 完全な buildGameDefinition (registry.json 全体の組み立て) は Phase 7 D-2 で
// scripts/register-game.mjs の処理を移植して実装する。B-0a では tier 別の
// コスト field 解決 — security 上 load-bearing な部分 — だけを先に実装する。

import type {
  CostFields,
  GameDefinition,
  ModpackMeta,
  NewGameFormPlayer,
  Tier,
} from "./registry-types.js";

// player の新規追加 / admin が省略した場合に強制するサーバ側既定 (docs §5.3)。
export const COST_FIELD_DEFAULTS: CostFields = {
  memory_gb: 8,
  instance_types: ["r7a.large", "r6a.large"],
  ebs_size_gb: 30,
  spot_max_price_jpy_per_hour: null,
};

// requester の tier に応じてコスト系 field を確定する。
//
// **enforcement の本体** (docs §9.1 #2b): player はコスト field を送ってきても無視し、
// 必ず COST_FIELD_DEFAULTS を適用する。admin のみ要求値を採用 (未指定は既定で補完)。
// UI 非表示は UX に過ぎず、実ガードはこのサーバ側関数で行う。
export function resolveCostFields(
  requested: Partial<CostFields> | undefined,
  tier: Tier,
): CostFields {
  if (tier !== "admin" || !requested) {
    return { ...COST_FIELD_DEFAULTS };
  }
  return {
    memory_gb: requested.memory_gb ?? COST_FIELD_DEFAULTS.memory_gb,
    instance_types:
      requested.instance_types ?? COST_FIELD_DEFAULTS.instance_types,
    ebs_size_gb: requested.ebs_size_gb ?? COST_FIELD_DEFAULTS.ebs_size_gb,
    spot_max_price_jpy_per_hour:
      requested.spot_max_price_jpy_per_hour ??
      COST_FIELD_DEFAULTS.spot_max_price_jpy_per_hour,
  };
}

// env 内でコスト・サーバサイズに直結する key (top-level とは別扱い、docs §1.1 / §5.3)。
const COST_ENV_KEY = "MEMORY";

// 既存 GameDefinition に部分更新を適用する (PUT /admin/api/games/:id の中核)。
//
// **enforcement の本体** (docs §9.1 #2b / §6): tier!=='admin' のときコスト系 field
// (instance_types / ebs_size_gb / spot_max_price_jpy_per_hour / env.MEMORY) を更新値から
// **無視して既存値を強制復元**する。CF_FILE_ID 等の非コスト env / 非コスト field は player も
// 更新できる。UI 非表示に依存せずサーバ側でガードする純粋関数。
//
// - game_id は不変 (更新で変えられない)。
// - env は「既存 env に update.env をマージ」する (player が CF_FILE_ID だけ差し替えられる)。
//   その上で player の場合 env.MEMORY は既存値に戻す。
export function applyGameUpdate(
  existing: GameDefinition,
  update: Partial<GameDefinition>,
  tier: Tier,
): GameDefinition {
  const merged: GameDefinition = {
    ...existing,
    ...update,
    // game_id は URL の id 側を正とし、更新で変えさせない。
    game_id: existing.game_id,
  };

  // env はマージ (update.env の指定キーだけ上書き、他は既存維持)。
  if (update.env !== undefined) {
    merged.env = { ...existing.env, ...update.env };
  }

  if (tier !== "admin") {
    // コスト系 top-level field を既存値に強制復元 (個別代入で型安全に)。
    merged.instance_types = existing.instance_types;
    merged.ebs_size_gb = existing.ebs_size_gb;
    merged.spot_max_price_jpy_per_hour = existing.spot_max_price_jpy_per_hour;
    // env.MEMORY を既存値に戻す (キーが無ければ player 由来の MEMORY を落とす)。
    const env = { ...merged.env };
    const existingMemory = existing.env[COST_ENV_KEY];
    if (existingMemory !== undefined) {
      env[COST_ENV_KEY] = existingMemory;
    } else {
      delete env[COST_ENV_KEY];
    }
    merged.env = env;
  }

  return merged;
}

// ---- Phase 7 D-2: NewGameForm → GameDefinition の組み立て + 入力検証 ----
//
// register-game.mjs は registry.json を人手で書く前提だったが、WebUI からの新規追加は
// フォーム入力 (NewGameForm) から GameDefinition を生成する。ここは **AWS に触れない純粋変換**
// (ADR 0004)。DNS A 作成 / KV put は admin-webui の handler 側が行い、生成された record_id を
// cfRecordId として渡す。S3 config sync / SSM rcon password の provisioning は AWS 操作なので
// この層には入れない (AUTO_CURSEFORGE は boot 時に CF から pack を取得するため新規追加時点では
// S3 config は不要。SSM rcon は E-1 の RPC 経路で別途用意する — docs §6.1 / §10.0)。

const MOD_LOADERS = ["NEOFORGE", "FORGE", "FABRIC", "QUILT"] as const;
type ModLoader = (typeof MOD_LOADERS)[number];

// kebab-case (英小文字始まり)。game_id / subdomain 共用の DNS label 安全パターン。
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// 検証済みフォーム。cost 系は admin が送ったときだけ載る (player は無視され既定強制)。
export type ValidatedNewGameForm = NewGameFormPlayer & Partial<CostFields>;

export type ValidationResult =
  | { ok: true; value: ValidatedNewGameForm }
  | { ok: false; error: string };

function isPositiveInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x > 0;
}

function isModLoader(x: unknown): x is ModLoader {
  return (
    typeof x === "string" && (MOD_LOADERS as readonly string[]).includes(x)
  );
}

function invalid(error: string): ValidationResult {
  return { ok: false, error };
}

// POST /admin/api/games の body を検証し、正規化済みフォームを返す (純粋・tier 非依存)。
// cost 系 field は shape のみ検証する — 実際に採用するか (admin) 無視するか (player) は
// buildGameDefinition の resolveCostFields が tier に応じて決める (enforcement の本体)。
export function validateNewGameForm(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalid("body must be an object");
  }
  const b = body as Record<string, unknown>;

  const game_id = b["game_id"];
  if (
    typeof game_id !== "string" ||
    !KEBAB.test(game_id) ||
    game_id.length > 32
  ) {
    return invalid(
      "game_id must be kebab-case (a-z start, a-z/0-9/-), ≤32 chars",
    );
  }

  const display_name =
    typeof b["display_name"] === "string" ? b["display_name"].trim() : "";
  if (display_name === "" || display_name.length > 64) {
    return invalid("display_name is required (1–64 chars)");
  }

  // subdomain は省略時 game_id。指定時は DNS label として検証。
  let subdomain = game_id;
  if (b["subdomain"] !== undefined) {
    const s = b["subdomain"];
    if (typeof s !== "string" || !KEBAB.test(s) || s.length > 63) {
      return invalid("subdomain must be a kebab-case DNS label");
    }
    subdomain = s;
  }

  const cf_slug = typeof b["cf_slug"] === "string" ? b["cf_slug"].trim() : "";
  if (cf_slug === "") return invalid("cf_slug is required");

  const meta = b["cf_modpack_meta"];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return invalid("cf_modpack_meta is required");
  }
  const m = meta as Record<string, unknown>;
  if (!isPositiveInt(m["modId"])) {
    return invalid("cf_modpack_meta.modId must be a positive integer");
  }
  const minecraftVersion =
    typeof m["minecraftVersion"] === "string"
      ? m["minecraftVersion"].trim()
      : "";
  if (minecraftVersion === "") {
    return invalid("cf_modpack_meta.minecraftVersion is required");
  }
  if (!isModLoader(m["modLoader"])) {
    return invalid(
      `cf_modpack_meta.modLoader must be one of ${MOD_LOADERS.join(", ")}`,
    );
  }
  const cf_modpack_meta: ModpackMeta = {
    modId: m["modId"],
    minecraftVersion,
    modLoader: m["modLoader"],
  };

  // port 既定 25565。
  let port = 25565;
  if (b["port"] !== undefined) {
    if (!isPositiveInt(b["port"]) || b["port"] > 65535) {
      return invalid("port must be an integer in 1–65535");
    }
    port = b["port"];
  }

  const value: ValidatedNewGameForm = {
    game_id,
    display_name,
    subdomain,
    cf_slug,
    cf_modpack_meta,
    port,
  };

  if (b["cf_file_id"] !== undefined) {
    if (!isPositiveInt(b["cf_file_id"])) {
      return invalid("cf_file_id must be a positive integer");
    }
    value.cf_file_id = b["cf_file_id"];
  }

  // cost 系 (optional)。値が来たら型を検証 (採用可否は tier 次第、ここでは shape のみ)。
  if (b["memory_gb"] !== undefined) {
    if (!isPositiveInt(b["memory_gb"])) {
      return invalid("memory_gb must be a positive integer");
    }
    value.memory_gb = b["memory_gb"];
  }
  if (b["instance_types"] !== undefined) {
    const it = b["instance_types"];
    if (
      !Array.isArray(it) ||
      it.length === 0 ||
      !it.every((t) => typeof t === "string" && t !== "")
    ) {
      return invalid("instance_types must be a non-empty string array");
    }
    value.instance_types = it as string[];
  }
  if (b["ebs_size_gb"] !== undefined) {
    if (!isPositiveInt(b["ebs_size_gb"])) {
      return invalid("ebs_size_gb must be a positive integer");
    }
    value.ebs_size_gb = b["ebs_size_gb"];
  }
  if (b["spot_max_price_jpy_per_hour"] !== undefined) {
    const sp = b["spot_max_price_jpy_per_hour"];
    if (
      sp !== null &&
      (typeof sp !== "number" || !Number.isFinite(sp) || sp <= 0)
    ) {
      return invalid(
        "spot_max_price_jpy_per_hour must be a positive number or null",
      );
    }
    value.spot_max_price_jpy_per_hour = sp as number | null;
  }

  return { ok: true, value };
}

// 検証済みフォーム → GameDefinition。AUTO_CURSEFORGE (itzg) 経路の MC modded サーバを
// atm10 をモデルに生成する。コスト系は resolveCostFields(form, tier) で確定 (player は既定強制)。
// cfRecordId は handler が DNS A を作って得た Cloudflare record id。
export function buildGameDefinition(
  form: ValidatedNewGameForm,
  tier: Tier,
  cfRecordId: string,
): GameDefinition {
  const cost = resolveCostFields(form, tier);
  const id = form.game_id;

  const env: Record<string, string> = {
    EULA: "TRUE",
    TYPE: form.cf_modpack_meta.modLoader,
    MODPACK_PLATFORM: "AUTO_CURSEFORGE",
    CF_SLUG: form.cf_slug,
    // CF_API_KEY は EC2 側で SSM /gs/global/cf_api_key から解決 (docs §3.2)。
    CF_API_KEY_FROM_SSM: "/gs/global/cf_api_key",
    VERSION: form.cf_modpack_meta.minecraftVersion,
    MEMORY: `${cost.memory_gb}G`,
    MOTD: form.display_name,
    MAX_PLAYERS: "20",
    ENABLE_RCON: "true",
    RCON_PORT: "25575",
    RCON_PASSWORD_FROM_SSM: `/gs/${id}/rcon_password`,
  };
  // 版固定 (未指定なら itzg が latest を解決)。
  if (form.cf_file_id !== undefined) {
    env["CF_FILE_ID"] = String(form.cf_file_id);
  }

  return {
    game_id: id,
    display_name: form.display_name,
    category: "minecraft-modded",
    enabled: true,
    instance_types: cost.instance_types,
    ebs_size_gb: cost.ebs_size_gb,
    seed_snapshot_id: null,
    spot_max_price_jpy_per_hour: cost.spot_max_price_jpy_per_hour,
    subdomain: form.subdomain,
    cf_record_id: cfRecordId,
    ports: [{ port: form.port, proto: "TCP" }],
    container_image: "itzg/minecraft-server:java21",
    image_source: "pull",
    env,
    config_s3_prefix: `s3://gs-game-configs/${id}/`,
    idle_check: {
      type: "minecraft_rcon",
      timeout_min: 10,
      heartbeat_interval_sec: 60,
      config: {
        host: "localhost",
        port: 25575,
        password_source: `ssm:/gs/${id}/rcon_password`,
        command: "list",
        empty_pattern: "There are 0 of a max",
      },
    },
    snapshot: {
      generations: 3,
      weekly_s3_backup: true,
      tags: { Project: "game-servers", Game: id, Purpose: "game-world" },
    },
    discord: {
      start_message: `${form.display_name} を起動しています… (EC2 の確保に 1〜2 分)`,
      ready_message: "サーバーの起動が完了しました",
      stop_message: `${form.display_name} を停止しました。次回起動まで世界は保存されています`,
    },
  };
}
