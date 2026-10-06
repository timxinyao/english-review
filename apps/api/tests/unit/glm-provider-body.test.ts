import { describe, expect, it } from 'vitest';
import { createGlmProvider } from '../../src/ai/provider/glm.js';
import type { AppConfig } from '../../src/config.js';

function config(): AppConfig {
  return {
    port: 5174,
    host: '127.0.0.1',
    nodeEnv: 'test',
    sessionSecret: 'test-session-secret-0123456789abcdef',
    authPassword: 'test-password',
    databasePath: ':memory:',
    appOrigins: [],
    appTimezone: 'Asia/Shanghai',
    glmApiKey: 'test-key',
    glmApiBase: 'https://example.test',
    glmModels: { flash: '', air: '', max: '' },
    glmMaxTokens: 8192,
    aiBgApiKey: '',
    aiBgApiBase: 'https://open.bigmodel.cn/api/anthropic',
    aiBgModels: { flash: '', air: '', max: '' },
    glmThinking: null,
    cookieSecure: false,
    vapid: null,
  };
}

function fakeFetch(): { fetcher: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { fetcher, bodies };
}

describe('GLM provider 请求体组装（thinking 档位）', () => {
  it('off：显式 thinking disabled（GLM 端点不传会自发思考），max_tokens=配置值', async () => {
    const { fetcher, bodies } = fakeFetch();
    const provider = createGlmProvider(config(), fetcher);
    await provider.complete({
      task: 'generateClozeQuestions',
      model: 'glm-5.3-flash',
      temperature: 0.7,
      thinking: 'off',
      prompt: 'p',
      vars: {},
    });
    const body = bodies[0] as { thinking: { type: string }; max_tokens: number };
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(8192);
  });

  it('low：thinking.budget_tokens=2048，max_tokens 抬升为预算+正文额度', async () => {
    const { fetcher, bodies } = fakeFetch();
    const provider = createGlmProvider(config(), fetcher);
    await provider.complete({
      task: 'checkProduction',
      model: 'glm-5.3',
      temperature: 0.2,
      thinking: 'low',
      prompt: 'p',
      vars: {},
    });
    const body = bodies[0] as {
      thinking: { type: string; budget_tokens: number };
      max_tokens: number;
    };
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(body.max_tokens).toBeGreaterThanOrEqual(2048 + 8192);
  });

  it('max：budget_tokens=16384', async () => {
    const { fetcher, bodies } = fakeFetch();
    const provider = createGlmProvider(config(), fetcher);
    await provider.complete({
      task: 'judgeDuplicateMeaning',
      model: 'glm-5.3',
      temperature: 0.2,
      thinking: 'max',
      prompt: 'p',
      vars: {},
    });
    expect((bodies[0] as { thinking: { budget_tokens: number } }).thinking.budget_tokens).toBe(
      16384,
    );
  });
});

/** 第一次调用挂起（模拟慢请求）：与真实 fetch 一致，abort 时 reject AbortError；第二次起成功 */
function hangThenSuccessFetcher() {
  let calls = 0;
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    signals.push(init?.signal);
    if (calls === 1) {
      return new Promise<never>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { fetcher, getCalls: () => calls, signals };
}

/** 每次调用都挂起直到 abort（重试后仍超时） */
function alwaysHangingFetcher() {
  let calls = 0;
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    return new Promise<never>((_, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    });
  }) as unknown as typeof fetch;
  return { fetcher, getCalls: () => calls };
}

describe('GLM provider timeoutMs 与超时单次重试（2026-10-03 批改长尾收紧）', () => {
  it('timeoutMs 生效：首次超时 abort 后立即重试一次成功，fetcher 共 2 次（重试用新 controller）', async () => {
    const { fetcher, getCalls, signals } = hangThenSuccessFetcher();
    const provider = createGlmProvider(config(), fetcher);
    const result = await provider.complete({
      task: 'checkProduction',
      model: 'glm-5.3',
      temperature: 0.2,
      thinking: 'medium',
      prompt: 'p',
      vars: {},
      timeoutMs: 35,
    });
    expect(result).toBe('{"ok":true}');
    expect(getCalls()).toBe(2);
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBeDefined();
    expect(signals[0]).not.toBe(signals[1]); // 第二次是全新 AbortController
  });

  it('重试后仍超时：抛超时错误且 fetcher 恰好 2 次（不再第三次）', async () => {
    const { fetcher, getCalls } = alwaysHangingFetcher();
    const provider = createGlmProvider(config(), fetcher);
    await expect(
      provider.complete({
        task: 'checkProduction',
        model: 'glm-5.3',
        temperature: 0.2,
        thinking: 'medium',
        prompt: 'p',
        vars: {},
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/超时/);
    expect(getCalls()).toBe(2);
  });

  it('非超时错误（HTTP 500）不重试：fetcher 仅 1 次', async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;
    const provider = createGlmProvider(config(), fetcher);
    await expect(
      provider.complete({
        task: 'checkProduction',
        model: 'glm-5.3',
        temperature: 0.2,
        thinking: 'medium',
        prompt: 'p',
        vars: {},
        timeoutMs: 35,
      }),
    ).rejects.toThrow('GLM HTTP 500');
    expect(calls).toBe(1);
  });
});
