import { describe, expect, it } from 'vitest';
import type { AiTask } from '@el/shared';
import type { AppConfig } from '../../src/config.js';
import {
  resolveThinking,
  TASK_MODEL_POLICY,
  THINKING_BUDGET_TOKENS,
} from '../../src/ai/taskConfig.js';

function configWithThinking(thinking: AppConfig['glmThinking']): AppConfig {
  return {
    port: 5174,
    host: '127.0.0.1',
    nodeEnv: 'test',
    sessionSecret: 'test-session-secret-0123456789abcdef',
    authPassword: 'test-password',
    databasePath: ':memory:',
    appOrigins: [],
    appTimezone: 'Asia/Shanghai',
    glmApiBase: 'https://example.test',
    glmModels: { flash: '', air: '', max: '' },
    glmMaxTokens: 8192,
    glmThinking: thinking,
    cookieSecure: false,
  };
}

describe('resolveThinking', () => {
  it('未设置全局 → 按任务策略（2026-09-25 基准矩阵）', () => {
    const config = configWithThinking(null);
    // 批改：唯一 main+思考的组合（100% 首过 · 14s）
    expect(resolveThinking('checkProduction', config)).toBe('medium');
    // 简单判定：cloze off（100%·2.3s）；judge low（89%→100%）
    expect(resolveThinking('checkCloze', config)).toBe('off');
    expect(resolveThinking('judgeDuplicateMeaning', config)).toBe('low');
    // 生成类全部 off（思考档超时劣化）
    expect(resolveThinking('generateUnderstandingQuestions', config)).toBe('off');
    expect(resolveThinking('generateClozeQuestions', config)).toBe('off');
    expect(resolveThinking('generateProductionPrompt', config)).toBe('off');
    expect(resolveThinking('generateRead', config)).toBe('off');
  });

  it('GLM_THINKING 全局强制覆盖（含 max）', () => {
    expect(resolveThinking('checkProduction', configWithThinking('max'))).toBe('max');
    expect(resolveThinking('generateClozeQuestions', configWithThinking('off'))).toBe('off');
    expect(resolveThinking('generateRead', configWithThinking('high'))).toBe('high');
  });

  it('每档预算单调递增且 max 最大', () => {
    expect(THINKING_BUDGET_TOKENS.low).toBeLessThan(THINKING_BUDGET_TOKENS.high);
    expect(THINKING_BUDGET_TOKENS.high).toBeLessThan(THINKING_BUDGET_TOKENS.max);
  });

  it('任务策略完整：7 个任务都有 thinking 档位', () => {
    for (const task of Object.keys(TASK_MODEL_POLICY) as AiTask[]) {
      expect(['off', 'low', 'medium', 'high', 'max']).toContain(TASK_MODEL_POLICY[task].thinking);
    }
  });
});
