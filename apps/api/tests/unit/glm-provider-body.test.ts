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
    glmThinking: null,
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
  it('off：不带 thinking 参数，max_tokens=配置值', async () => {
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
    const body = bodies[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('thinking');
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
