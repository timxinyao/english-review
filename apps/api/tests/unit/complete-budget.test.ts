import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiStructuredError, completeStructured } from '../../src/ai/complete.js';
import type { AiProvider, ProviderRequest } from '../../src/ai/provider/index.js';
import { loadPromptRegistry } from '../../src/ai/promptRegistry.js';
import { MAX_STRUCTURED_RETRIES, TASK_MODEL_POLICY } from '../../src/ai/taskConfig.js';
import { testAiConfig } from '../helpers/ai.js';

/** checkProduction 渲染所需最小变量（renderPrompt 缺变量即抛） */
const PRODUCTION_VARS: Record<string, unknown> = {
  type: 'word',
  target: 'compelling',
  meaning: '令人信服的',
  source_example: 'a compelling story',
  reference_answer: 'The story was compelling.',
  zh_prompt: '用 compelling 描述一个故事',
  user_answer: 'The story is compelling.',
  acceptance_notes: '',
};

/**
 * 记录每次收到的 timeoutMs、消耗 mock 时间后抛超时错误的 provider。
 * consumeMs（默认 2×timeoutMs）模拟"provider 内部仅超时重试一次后仍超时"的最坏耗时。
 */
function budgetBurningProvider(): { provider: AiProvider; timeoutMsLog: number[] } {
  const timeoutMsLog: number[] = [];
  const provider: AiProvider = {
    name: 'glm',
    async complete(req: ProviderRequest) {
      timeoutMsLog.push(req.timeoutMs ?? -1);
      await vi.advanceTimersByTimeAsync((req.timeoutMs ?? 120_000) * 2);
      throw new Error(`GLM 请求超时（${req.timeoutMs}ms）`);
    },
  };
  return { provider, timeoutMsLog };
}

describe('completeStructured 端到端预算（2026-10-04 批改 504 事故）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checkProduction 声明 120s 预算，且 < nginx 180s 与前端 150s 中止', () => {
    const policy = TASK_MODEL_POLICY.checkProduction;
    expect(policy.totalBudgetMs).toBe(120_000);
    expect(policy.totalBudgetMs!).toBeLessThan(180_000);
    expect(policy.totalBudgetMs!).toBeLessThan(150_000);
  });

  it('预算内多次 attempt 的 timeoutMs 被按剩余预算裁剪（剩余/2，不超任务 60s）', async () => {
    const { provider, timeoutMsLog } = budgetBurningProvider();
    const start = Date.now();
    await expect(
      completeStructured(
        {
          provider,
          config: testAiConfig(),
          registry: loadPromptRegistry(join(process.cwd(), 'prompts')),
        },
        'checkProduction',
        PRODUCTION_VARS,
      ),
    ).rejects.toBeInstanceOf(AiStructuredError);
    // attempt1：剩余 120s → min(60s, 60s)=60s；消耗 2×60s 后剩余 0 → 停止
    expect(timeoutMsLog).toEqual([60_000]);
    expect(Date.now() - start).toBeLessThanOrEqual(120_000 + 5_000);
  });

  it('预算耗尽停止重试并按失败路径返回错误（attempt 少于上限，错误信息含预算标记）', async () => {
    // 每次固定消耗 58s：attempt1 后剩 62s，attempt2 后剩 4s < 5s 停止
    const timeoutMsLog: number[] = [];
    const provider: AiProvider = {
      name: 'glm',
      async complete(req: ProviderRequest) {
        timeoutMsLog.push(req.timeoutMs ?? -1);
        await vi.advanceTimersByTimeAsync(58_000);
        throw new Error('模拟长尾失败');
      },
    };
    const start = Date.now();
    const promise = completeStructured(
      {
        provider,
        config: testAiConfig(),
        registry: loadPromptRegistry(join(process.cwd(), 'prompts')),
      },
      'checkProduction',
      PRODUCTION_VARS,
    );
    await expect(promise).rejects.toThrow(/端到端预算 120000ms 耗尽/);
    // attempt1 剩余 120s→60s；attempt2 剩余 62s→31s；attempt3 剩余 4s < 5s 停止
    expect(timeoutMsLog).toEqual([60_000, 31_000]);
    expect(Date.now() - start).toBeLessThanOrEqual(120_000 + 5_000);
  });

  it('无预算任务行为不变：不裁剪 timeoutMs，重试满 MAX_STRUCTURED_RETRIES 次', async () => {
    const timeoutMsLog: number[] = [];
    const provider: AiProvider = {
      name: 'glm',
      async complete(req: ProviderRequest) {
        timeoutMsLog.push(req.timeoutMs ?? -1);
        throw new Error('模拟 provider 故障');
      },
    };
    const config = testAiConfig();
    // generateClozeQuestions 无 totalBudgetMs/timeoutMs：三次 attempt 均不传 timeoutMs
    await expect(
      completeStructured(
        { provider, config, registry: loadPromptRegistry(join(process.cwd(), 'prompts')) },
        'generateClozeQuestions',
        {
          type: 'word',
          target: 't',
          meaning: 'm',
          source_example: 'e',
          count: 2,
          content_level: 'word',
        },
      ),
    ).rejects.toThrow(AiStructuredError);
    expect(timeoutMsLog).toEqual(Array.from({ length: MAX_STRUCTURED_RETRIES + 1 }, () => -1));
  });
});
