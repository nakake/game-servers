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
  spot_max_price_jpy_per_hour: number | null;

  subdomain: string;
  cf_record_id: string;
  ports: Array<{ port: number; proto: 'TCP' | 'UDP' }>;

  container_image: string;
  container_image_note?: string;
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
