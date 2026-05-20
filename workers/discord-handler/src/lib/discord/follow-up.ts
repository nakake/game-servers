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

  // interaction に対する follow-up メッセージを新規作成する (元メッセージは残したまま追加投稿)。
  // メッセージ "作成" イベントなので allowed_mentions に載せた user は push 通知 (ping) される。
  // ※ editOriginal による "編集" では mention は表示されても ping は飛ばないため、
  //   起動完了を音付きで知らせたい場合はこちらを使う。
  // ※ editOriginal 同様 interaction token の 15 分有効期限に従う (超過時は HTTP 404)。
  async createFollowUp(
    content: string,
    options?: { mentionUserIds?: string[] },
  ): Promise<void> {
    const url = `${this.baseUrl}/webhooks/${this.applicationId}/${this.token}`;
    const body: Record<string, unknown> = { content };
    if (options?.mentionUserIds !== undefined && options.mentionUserIds.length > 0) {
      // parse: [] で @everyone / role の暴発を防ぎ、明示した user だけ ping する。
      body.allowed_mentions = { parse: [], users: options.mentionUserIds };
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Discord createFollowUp failed (HTTP ${response.status}): ${text.slice(0, 300)}`,
      );
    }
  }
}
