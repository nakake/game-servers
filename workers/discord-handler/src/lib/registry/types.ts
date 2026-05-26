// games/<id>/registry.json のスキーマ型定義 (design.md §3.1)。
//
// JSON 側のフィールド名は snake_case を維持する (Workers KV に投入されるソースなので、
// TypeScript 側で camelCase 変換せずそのまま使う方が AWS タグ / Worker bindings と整合)。

export type GameCategory =
  | 'minecraft-vanilla'
  | 'minecraft-modded'
  | 'terraria'
  | 'valheim'
  | 'factorio';

export interface GameDefinition {
  game_id: string;
  display_name: string;
  category: GameCategory;
  enabled: boolean;

  instance_types: string[];
  ebs_size_gb: number;
  // 初回起動の種 snapshot。null / 未指定なら blank EBS を mkfs して起動する。
  // Phase 0 で手動作成した snapshot を一度だけ使う用途。以降は /stop が作る
  // game-world snapshot が優先されるため、実質的にブートストラップ専用。
  seed_snapshot_id?: string | null;
  // 初回起動時に S3 から取得して /data 配下に展開する modpack zip の S3 URI
  // (s3://bucket/key)。formatBlankVolume=true の経路でのみ使用、snapshot 復元時は
  // 触らない。aws s3 cp で取得し unzip で展開、IAM は EC2 instance profile に依存。
  // 例: "s3://gs-game-configs/atm10/modpack/server-pack.zip"
  seed_modpack_s3_uri?: string;
  spot_max_price_jpy_per_hour: number | null;

  subdomain: string;
  cf_record_id: string;
  ports: Array<{ port: number; proto: 'TCP' | 'UDP' }>;

  container_image: string;
  container_image_note?: string;
  // EC2 でのコンテナ取得方法。
  //   "build": launcher tarball を S3 から取得し EC2 上で docker build (自前イメージ)
  //   "pull" : container_image を docker pull (公開イメージで完結するゲーム)
  image_source: 'build' | 'pull';
  env: Record<string, string>;
  config_s3_prefix: string;

  idle_check: {
    type: 'minecraft_rcon' | 'tshock_rest' | 'steam_query' | 'factorio_rcon';
    timeout_min: number;
    heartbeat_interval_sec?: number;
    config: Record<string, unknown>;
  };

  snapshot: {
    generations: number;
    weekly_s3_backup: boolean;
    tags?: Record<string, string>;
  };

  discord: {
    start_message: string;
    ready_message: string;
    stop_message: string;
  };
}
