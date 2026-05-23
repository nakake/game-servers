import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { postDiscordWebhookMessage } from './webhook.js';
import type { Env } from '../../env.js';

const WEBHOOK_URL = 'https://discord.com/api/webhooks/test/abc';

// 必要最小限の Env stub。テストごとに DISCORD_WEBHOOK_URL を上書きする。
function makeEnv(webhook: string | undefined): Env {
  return { DISCORD_WEBHOOK_URL: webhook } as unknown as Env;
}

// fetch を mock し、最後の呼び出しの body を JSON で取り出す。
function captureLastFetchBody(): Record<string, unknown> {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  expect(fetchMock).toHaveBeenCalled();
  const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  // Discord webhook の成功レスポンス相当 (Discord は 204 No Content を返すが、Response
  // コンストラクタは status 204 と非 null body の併用を spec で禁じている。テストの ergonomics
  // を優先して 200 + empty body を使う、ok===true の判定は同等)。
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  // console.warn を黙らせる (テスト出力を汚さない、call は assert したい場合のみ覗く)。
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('postDiscordWebhookMessage', () => {
  it('returns false and skips fetch when DISCORD_WEBHOOK_URL is undefined', async () => {
    const ok = await postDiscordWebhookMessage(makeEnv(undefined), { content: 'hi' });
    expect(ok).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('returns false and skips fetch when DISCORD_WEBHOOK_URL is an empty string', async () => {
    const ok = await postDiscordWebhookMessage(makeEnv(''), { content: 'hi' });
    expect(ok).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns false and skips fetch when neither content nor embeds provided', async () => {
    const ok = await postDiscordWebhookMessage(makeEnv(WEBHOOK_URL), {});
    expect(ok).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('POSTs content + allowed_mentions with parse:[] (no mention ping by default)', async () => {
    const ok = await postDiscordWebhookMessage(makeEnv(WEBHOOK_URL), { content: 'hello' });
    expect(ok).toBe(true);
    const body = captureLastFetchBody();
    expect(body.content).toBe('hello');
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds).toBeUndefined();
  });

  it('POSTs embeds only (no content)', async () => {
    const embed = { title: 't', description: 'd', color: 0x123456 };
    const ok = await postDiscordWebhookMessage(makeEnv(WEBHOOK_URL), { embeds: [embed] });
    expect(ok).toBe(true);
    const body = captureLastFetchBody();
    expect(body.embeds).toEqual([embed]);
    expect(body.content).toBeUndefined();
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it('passes mentionUserIds through allowed_mentions.users (ping only those users)', async () => {
    const ok = await postDiscordWebhookMessage(makeEnv(WEBHOOK_URL), {
      content: '<@111> heads up',
      mentionUserIds: ['111', '222'],
    });
    expect(ok).toBe(true);
    const body = captureLastFetchBody();
    expect(body.allowed_mentions).toEqual({ parse: [], users: ['111', '222'] });
  });

  it('empty mentionUserIds does NOT add users key (still parse:[] only)', async () => {
    const ok = await postDiscordWebhookMessage(makeEnv(WEBHOOK_URL), {
      content: 'no mention',
      mentionUserIds: [],
    });
    expect(ok).toBe(true);
    const body = captureLastFetchBody();
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it('ignores empty embeds array (treated as not provided)', async () => {
    const ok = await postDiscordWebhookMessage(makeEnv(WEBHOOK_URL), {
      content: 'x',
      embeds: [],
    });
    expect(ok).toBe(true);
    const body = captureLastFetchBody();
    expect(body.embeds).toBeUndefined();
  });

  it('returns false (no throw) when Discord returns non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );
    const ok = await postDiscordWebhookMessage(makeEnv(WEBHOOK_URL), { content: 'x' });
    expect(ok).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('returns false (no throw) when fetch itself throws (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    const ok = await postDiscordWebhookMessage(makeEnv(WEBHOOK_URL), { content: 'x' });
    expect(ok).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('uses POST with application/json content-type and targets DISCORD_WEBHOOK_URL', async () => {
    await postDiscordWebhookMessage(makeEnv(WEBHOOK_URL), { content: 'x' });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});
