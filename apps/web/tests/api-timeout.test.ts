import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/lib/api';

/** 永挂 fetch：与真实 fetch 一致，signal abort 时 reject AbortError（模拟 iOS 后台冻结；
 *  传入前已 aborted 的 signal 立即 reject，与真实 fetch 语义相同） */
function hangingFetch(): typeof fetch {
  return ((_path: unknown, init?: RequestInit) => {
    return new Promise<never>((_, reject) => {
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      init?.signal?.addEventListener('abort', abort);
    });
  }) as unknown as typeof fetch;
}

describe('api 全局请求超时（iOS 后台冻结 fetch 兜底）', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetch 永挂：150s 后 abort 并抛「请求超时，请重试」（ApiError，status=0）', async () => {
    globalThis.fetch = vi.fn(hangingFetch());
    const promise = api('/api/today/start', { method: 'POST', body: '{}' });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'ApiError',
      code: 'REQUEST_TIMEOUT',
      message: '请求超时，请重试',
      status: 0,
    });
    await vi.advanceTimersByTimeAsync(150_000);
    await assertion;
  });

  it('150s 内正常返回：不触发超时，且 resolve 后清理定时器（无泄漏）', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    await expect(api('/api/health')).resolves.toEqual({ ok: 1 });
    expect(vi.getTimerCount()).toBe(0);
    // 此后推进远超 150s，不应有任何延迟 abort 副作用
    await vi.advanceTimersByTimeAsync(300_000);
  });

  it('fetch 带 AbortController signal（超时机制接入调用链）', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    await api('/api/health');
    const init = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('外部 signal 桥接（造句批改中取消）：外部 abort → fetch 收到 abort，原样抛 AbortError 不覆盖为「请求超时」', async () => {
    globalThis.fetch = vi.fn(hangingFetch());
    const external = new AbortController();
    const promise = api('/api/today/tasks/t1/answer', {
      method: 'POST',
      body: '{}',
      signal: external.signal,
    });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    external.abort();
    await assertion;
    // 外部 abort 的文案由调用方处理（取消静默），不得报自身超时话术
    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('请求超时');
  });

  it('外部 signal 桥接：调用前已 abort → fetch 收到已中止的 signal 立即失败', async () => {
    const fetchMock = vi.fn(hangingFetch());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const external = new AbortController();
    external.abort();
    await expect(api('/api/x', { method: 'POST', signal: external.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('外部 signal 存在时自身 150s 超时仍生效（两路互不削弱）', async () => {
    globalThis.fetch = vi.fn(hangingFetch());
    const external = new AbortController();
    const promise = api('/api/today/start', {
      method: 'POST',
      body: '{}',
      signal: external.signal,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'ApiError',
      code: 'REQUEST_TIMEOUT',
      message: '请求超时，请重试',
      status: 0,
    });
    await vi.advanceTimersByTimeAsync(150_000);
    await assertion;
  });

  it('非超时错误路径保持原语义：HTTP 错误响应仍抛结构化 ApiError', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'BAD', message: '坏的' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const err = await api('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('BAD');
    expect((err as ApiError).message).toBe('坏的');
    expect((err as ApiError).status).toBe(400);
  });
});
