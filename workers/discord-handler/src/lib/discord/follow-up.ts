// Discord interaction の follow-up message API。
//
// deferred response (type=5) を返した後、実処理完了時に元メッセージを更新するために使う。
// `PATCH /webhooks/{application_id}/{interaction_token}/messages/@original` は Bot Token 不要、
// interaction_token があれば誰でも編集できる (15 分の有効期限あり)。
//
// 参照:
//   https://discord.com/developers/docs/interactions/receiving-and-responding#edit-original-interaction-response

export interface DiscordFollowUpOptions {
  applicationId: string;
  interactionToken: string;
  // テスト用に base URL を差し替え可能。
  baseUrl?: string;
}

export class DiscordFollowUpClient {
  private readonly applicationId: string;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(options: DiscordFollowUpOptions) {
    this.applicationId = options.applicationId;
    this.token = options.interactionToken;
    this.baseUrl = options.baseUrl ?? 'https://discord.com/api/v10';
  }

  // deferred response で送ったメッセージの内容を差し替える。
  // Discord 側はオリジナルがまだ "Bot is thinking..." の状態でも編集可能。
  async editOriginal(content: string): Promise<void> {
    const url = `${this.baseUrl}/webhooks/${this.applicationId}/${this.token}/messages/@original`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord editOriginal failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
    }
  }
}
