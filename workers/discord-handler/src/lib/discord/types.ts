// Discord interaction の型定義 (Phase 1 で使う範囲のみ)。
//
// 完全な型は discord-api-types パッケージにあるが、依存追加を避けて自前で最小限。
// 参照: https://discord.com/developers/docs/interactions/receiving-and-responding

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
} as const;

export const ApplicationCommandOptionType = {
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
} as const;

export interface ApplicationCommandInteractionDataOption {
  name: string;
  type: number;
  value?: string | number | boolean;
}

export interface ApplicationCommandInteractionData {
  id: string;
  name: string;
  type: number;
  options?: ApplicationCommandInteractionDataOption[];
}

export interface Interaction {
  id: string;
  application_id: string;
  // Discord は token をクエリーパラメータでフォローアップ API URL に埋め込んで使う。
  token: string;
  type: number;
  data?: ApplicationCommandInteractionData;
  guild_id?: string;
  channel_id?: string;
  member?: {
    user?: { id: string; username: string };
  };
  user?: { id: string; username: string };
}
