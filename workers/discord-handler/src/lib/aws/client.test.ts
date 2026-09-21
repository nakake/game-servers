// client.ts のテスト。
//
// fetch を stub して、aws4fetch の内蔵リトライが止まっていること (retries: 0) と
// withRetry の再試行ポリシーを確認する:
//   - 5xx / 429 / Throttling は全 action で maxRetries + 1 = 6 回まで
//   - abort / ネットワークエラーは再送が安全な action だけ 1 回まで
//     (RunInstances は ClientToken があるときだけ)
//   - 読み取り系の 1 試行タイムアウトは 8 秒、それ以外は 15 秒
//
// aws4fetch の署名 (crypto.subtle) は real async なので、fetch が呼ばれるまで実イベント
// ループへ順番を譲る。fake timers 環境では setTimeout が fake されるため、module 読み込み時に
// 捕捉した real setTimeout を使う。backoff の待ちは fake timers で進める。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { AwsApiClient } from './client.js';
import { runInstances } from './ec2.js';
import { AwsApiError } from './errors.js';

const EC2_VERSION = '2016-11-15';

// fake timers 導入前に捕捉する (署名待ちの実イベントループ用)。
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

const ERROR_XML = '<ErrorResponse><Error><Code>InternalError</Code></Error></ErrorResponse>';
const SNAPSHOTS_XML = '<DescribeSnapshotsResponse/>';
const RUN_INSTANCES_XML = `<?xml version="1.0"?>
<RunInstancesResponse>
  <reservationId>r-test</reservationId>
  <instancesSet>
    <item>
      <instanceId>i-test</instanceId>
      <instanceState><name>pending</name></instanceState>
    </item>
  </instancesSet>
</RunInstancesResponse>`;

function makeClient(): AwsApiClient {
  return new AwsApiClient({
    region: 'ap-northeast-1',
    credentials: {
      accessKeyId: 'ASIATEST',
      secretAccessKey: 'test-secret',
      sessionToken: 'test-session-token',
    },
  });
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

// レスポンスが返らないまま signal の abort を待つ fetch mock (タイムアウト検証用)。
function hangingFetchMock(signals: AbortSignal[]): Mock {
  return vi.fn((request: Request) => {
    signals.push(request.signal);
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(abortError()));
    });
  });
}

// fetch が呼ばれる (= 署名が終わる) まで実イベントループに順番を譲る。
async function waitForFetchCount(fetchMock: Mock, count: number): Promise<void> {
  for (let i = 0; i < 500 && fetchMock.mock.calls.length < count; i++) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
  expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

// 署名 (real async) と backoff (fake timer) を交互に進めながら fetch 呼び出しを待つ。
// backoff は最大 3000ms + jitter 100ms なので、1 ステップで次の試行まで届く幅で進める。
const RETRY_ADVANCE_STEP_MS = 3_500;

async function advanceUntilFetchCount(fetchMock: Mock, count: number): Promise<void> {
  for (let i = 0; i < 200 && fetchMock.mock.calls.length < count; i++) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    await vi.advanceTimersByTimeAsync(RETRY_ADVANCE_STEP_MS);
  }
  expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// =============================================================================
// 5xx の再試行
// =============================================================================

const RETRYABLE_CASES: Array<{ name: string; call: (client: AwsApiClient) => Promise<unknown> }> = [
  {
    name: 'SendCommand (JSON)',
    call: (client) =>
      client.jsonRequest({ service: 'ssm', target: 'AmazonSSM.SendCommand', payload: {} }),
  },
  {
    name: 'GetCommandInvocation (JSON)',
    call: (client) =>
      client.jsonRequest({ service: 'ssm', target: 'AmazonSSM.GetCommandInvocation', payload: {} }),
  },
  {
    name: 'RunInstances',
    call: (client) =>
      client.queryRequest({ service: 'ec2', action: 'RunInstances', version: EC2_VERSION, params: {} }),
  },
  {
    name: 'TerminateInstances',
    call: (client) =>
      client.queryRequest({
        service: 'ec2',
        action: 'TerminateInstances',
        version: EC2_VERSION,
        params: {},
      }),
  },
  {
    name: 'CreateSnapshot',
    call: (client) =>
      client.queryRequest({ service: 'ec2', action: 'CreateSnapshot', version: EC2_VERSION, params: {} }),
  },
  {
    name: 'DeleteSnapshot',
    call: (client) =>
      client.queryRequest({ service: 'ec2', action: 'DeleteSnapshot', version: EC2_VERSION, params: {} }),
  },
  {
    name: 'DeleteVolume',
    call: (client) =>
      client.queryRequest({ service: 'ec2', action: 'DeleteVolume', version: EC2_VERSION, params: {} }),
  },
  {
    name: 'DescribeInstances',
    call: (client) =>
      client.queryRequest({
        service: 'ec2',
        action: 'DescribeInstances',
        version: EC2_VERSION,
        params: {},
      }),
  },
  {
    name: 'DescribeVolumes',
    call: (client) =>
      client.queryRequest({ service: 'ec2', action: 'DescribeVolumes', version: EC2_VERSION, params: {} }),
  },
  {
    name: 'DescribeSnapshots',
    call: (client) =>
      client.queryRequest({
        service: 'ec2',
        action: 'DescribeSnapshots',
        version: EC2_VERSION,
        params: {},
      }),
  },
];

describe('AwsApiClient — 5xx の再試行', () => {
  it.each(RETRYABLE_CASES)(
    '$name: 525 が続くと 6 回試行して諦める (内蔵リトライも止まっている)',
    async ({ call }) => {
      const fetchMock = vi.fn(async () => new Response(ERROR_XML, { status: 525 }));
      vi.stubGlobal('fetch', fetchMock);

      const assertion = expect(call(makeClient())).rejects.toBeInstanceOf(AwsApiError);
      await advanceUntilFetchCount(fetchMock, 6);
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(6);
    },
  );
});

// =============================================================================
// abort / ネットワークエラーの再試行 (許可リスト)
// =============================================================================

describe('AwsApiClient — abort の再試行', () => {
  it('DescribeSnapshots: 1 回目 abort → 2 回目成功なら成功する', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(new Response(SNAPSHOTS_XML, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(
      makeClient().queryRequest({
        service: 'ec2',
        action: 'DescribeSnapshots',
        version: EC2_VERSION,
        params: {},
      }),
    ).resolves.toBe(SNAPSHOTS_XML);

    await advanceUntilFetchCount(fetchMock, 2);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('DescribeSnapshots: abort が 2 回続くと失敗する (再試行は 1 回まで)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(abortError());
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(
      makeClient().queryRequest({
        service: 'ec2',
        action: 'DescribeSnapshots',
        version: EC2_VERSION,
        params: {},
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    await advanceUntilFetchCount(fetchMock, 2);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('CreateSnapshot: abort では再試行しない (fetch 1 回)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(abortError());
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(
      makeClient().queryRequest({
        service: 'ec2',
        action: 'CreateSnapshot',
        version: EC2_VERSION,
        params: {},
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'TerminateInstances',
      call: (client: AwsApiClient) =>
        client.queryRequest({
          service: 'ec2',
          action: 'TerminateInstances',
          version: EC2_VERSION,
          params: { 'InstanceId.1': 'i-test' },
        }),
    },
    {
      name: 'GetCommandInvocation',
      call: (client: AwsApiClient) =>
        client.jsonRequest({
          service: 'ssm',
          target: 'AmazonSSM.GetCommandInvocation',
          payload: {},
        }),
    },
  ])('$name: 1 回目 abort → 2 回目成功なら成功する (fetch 2 回)', async ({ call }) => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(call(makeClient())).resolves.toBeDefined();

    await advanceUntilFetchCount(fetchMock, 2);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'SendCommand',
      call: (client: AwsApiClient) =>
        client.jsonRequest({ service: 'ssm', target: 'AmazonSSM.SendCommand', payload: {} }),
    },
    {
      name: 'DeleteVolume',
      call: (client: AwsApiClient) =>
        client.queryRequest({
          service: 'ec2',
          action: 'DeleteVolume',
          version: EC2_VERSION,
          params: {},
        }),
    },
    {
      name: 'DeleteSnapshot',
      call: (client: AwsApiClient) =>
        client.queryRequest({
          service: 'ec2',
          action: 'DeleteSnapshot',
          version: EC2_VERSION,
          params: {},
        }),
    },
  ])('$name: abort では再試行しない (fetch 1 回)', async ({ call }) => {
    const fetchMock = vi.fn().mockRejectedValue(abortError());
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(call(makeClient())).rejects.toMatchObject({ name: 'AbortError' });

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 5xx と abort の混在
// =============================================================================

describe('AwsApiClient — 5xx と abort の混在', () => {
  function describeSnapshots(client: AwsApiClient): Promise<string> {
    return client.queryRequest({
      service: 'ec2',
      action: 'DescribeSnapshots',
      version: EC2_VERSION,
      params: {},
    });
  }

  it('525 → abort → 525 → 200 なら成功する', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(ERROR_XML, { status: 525 }))
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(new Response(ERROR_XML, { status: 525 }))
      .mockResolvedValueOnce(new Response(SNAPSHOTS_XML, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(describeSnapshots(makeClient())).resolves.toBe(SNAPSHOTS_XML);

    await advanceUntilFetchCount(fetchMock, 4);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('abort が 2 回来たら 2 回目は再試行しない (fetch 4 回で失敗)', async () => {
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls++;
      if (calls === 2 || calls === 4) return Promise.reject(abortError());
      return Promise.resolve(new Response(ERROR_XML, { status: 525 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(describeSnapshots(makeClient())).rejects.toMatchObject({
      name: 'AbortError',
    });

    await advanceUntilFetchCount(fetchMock, 4);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('5xx と abort が混ざっても総試行は 6 回まで (fetch 6 回で失敗)', async () => {
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls++;
      if (calls === 2) return Promise.reject(abortError());
      return Promise.resolve(new Response(ERROR_XML, { status: 525 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(describeSnapshots(makeClient())).rejects.toBeInstanceOf(AwsApiError);

    await advanceUntilFetchCount(fetchMock, 6);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

// =============================================================================
// RunInstances の ClientToken
// =============================================================================

describe('AwsApiClient — RunInstances の ClientToken', () => {
  it('再送されたとき 2 回の request body で ClientToken が同一', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (request: Request) => {
      bodies.push(await request.text());
      if (bodies.length === 1) throw abortError();
      return new Response(RUN_INSTANCES_XML, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(runInstances(makeClient(), { instanceType: 't3.micro' })).resolves.toMatchObject(
      { reservationId: 'r-test' },
    );

    await advanceUntilFetchCount(fetchMock, 2);
    await assertion;

    expect(bodies).toHaveLength(2);
    const tokens = bodies.map((body) => new URLSearchParams(body).get('ClientToken'));
    expect(tokens[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(tokens[1]).toBe(tokens[0]);
  });

  it('ClientToken なしの params で直接 queryRequest すると abort で再試行しない (fetch 1 回)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(abortError());
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(
      makeClient().queryRequest({
        service: 'ec2',
        action: 'RunInstances',
        version: EC2_VERSION,
        params: {},
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 1 試行のタイムアウト
// =============================================================================

describe('AwsApiClient — 1 試行のタイムアウト', () => {
  it('読み取り系 (DescribeSnapshots) は 8 秒で abort する', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = hangingFetchMock(signals);
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(
      makeClient().queryRequest({
        service: 'ec2',
        action: 'DescribeSnapshots',
        version: EC2_VERSION,
        params: {},
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // 署名が終わって fetch が呼ばれてから fake timer を進める。
    await waitForFetchCount(fetchMock, 1);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);

    // 2 試行目も 8 秒で abort し、再試行は 1 回までなので失敗する。
    await advanceUntilFetchCount(fetchMock, 2);
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('GetCommandInvocation (JSON) も 8 秒で abort する', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = hangingFetchMock(signals);
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(
      makeClient().jsonRequest({
        service: 'ssm',
        target: 'AmazonSSM.GetCommandInvocation',
        payload: {},
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    await waitForFetchCount(fetchMock, 1);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);

    // 2 試行目も 8 秒で abort し、再試行は 1 回までなので失敗する。
    await advanceUntilFetchCount(fetchMock, 2);
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('RunInstances は 15 秒のまま (読み取り系のように短縮しない)', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = hangingFetchMock(signals);
    vi.stubGlobal('fetch', fetchMock);

    const assertion = expect(
      runInstances(makeClient(), { instanceType: 't3.micro' }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    await waitForFetchCount(fetchMock, 1);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);

    await advanceUntilFetchCount(fetchMock, 2);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
