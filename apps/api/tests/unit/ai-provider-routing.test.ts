import { describe, expect, it } from 'vitest';
import type { AiTask } from '@el/shared';
import type { AppConfig } from '../../src/config.js';
import { TASK_MODEL_POLICY, providerSlotForTask } from '../../src/ai/taskConfig.js';
import { createRoutingProvider, type AiProvider, type ProviderRequest } from '../../src/ai/provider/index.js';
import { clearModelsCacheForTests, resolveModelForTask } from '../../src/ai/models.js';
import { testAiConfig } from '../helpers/ai.js';

function configWithBg(bg: Partial<Pick<AppConfig, 'aiBgApiKey' | 'aiBgApiBase' | 'aiBgModels'>>): AppConfig {
  return {
    ...testAiConfig(),
    aiBgApiKey: bg.aiBgApiKey ?? '',
    aiBgApiBase: bg.aiBgApiBase ?? 'https://open.bigmodel.cn/api/anthropic',
    aiBgModels: bg.aiBgModels ?? { flash: '', air: '', max: '' },
  };
}

/** 记录 task 并返回标记字符串的假 provider */
function fakeProvider(name: 'glm' | 'mock', mark: string): AiProvider & { tasks: AiTask[] } {
  const tasks: AiTask[] = [];
  return {
    name,
    tasks,
    async complete(req: ProviderRequest) {
      tasks.push(req.task);
      return mark;
    },
  };
}

describe('任务 → provider 槽路由（2026-10-06 双槽）', () => {
  it('策略标注：生成类+查重走 background，批改/短文/填空判定走 main', () => {
    expect(TASK_MODEL_POLICY.generateProductionPrompt.provider).toBe('background');
    expect(TASK_MODEL_POLICY.generateUnderstandingQuestions.provider).toBe('background');
    expect(TASK_MODEL_POLICY.generateClozeQuestions.provider).toBe('background');
    expect(TASK_MODEL_POLICY.judgeDuplicateMeaning.provider).toBe('background');
    expect(TASK_MODEL_POLICY.checkProduction.provider ?? 'main').toBe('main');
    expect(TASK_MODEL_POLICY.generateRead.provider ?? 'main').toBe('main');
    expect(TASK_MODEL_POLICY.checkCloze.provider ?? 'main').toBe('main');
  });

  it('后台槽未配 key → 全部任务回落 main', () => {
    const config = configWithBg({ aiBgApiKey: '' });
    for (const task of Object.keys(TASK_MODEL_POLICY) as AiTask[]) {
      expect(providerSlotForTask(task, config)).toBe('main');
    }
  });

  it('后台槽配 key → background 任务走 bg，main 任务不受影响', () => {
    const config = configWithBg({ aiBgApiKey: 'bg-key' });
    expect(providerSlotForTask('generateProductionPrompt', config)).toBe('background');
    expect(providerSlotForTask('judgeDuplicateMeaning', config)).toBe('background');
    expect(providerSlotForTask('checkProduction', config)).toBe('main');
  });

  it('createRoutingProvider：bg 未配/mock 主 provider 时原样返回 main；配置后按任务分发', async () => {
    const main = fakeProvider('glm', 'MAIN');
    const bg = fakeProvider('glm', 'BG');

    // bg 未配置 → 原样 main
    const noBg = createRoutingProvider(configWithBg({ aiBgApiKey: '' }), main, null);
    expect(noBg).toBe(main);

    // 主 provider 是 mock → 原样返回（生产守卫：mock 不与真实 AI 混跑）
    const mockMain = fakeProvider('mock', 'MOCK');
    expect(createRoutingProvider(configWithBg({ aiBgApiKey: 'k' }), mockMain, bg)).toBe(mockMain);

    // 配置齐全：background 任务 → bg，main 任务 → main
    const routed = createRoutingProvider(configWithBg({ aiBgApiKey: 'k' }), main, bg);
    expect(routed.name).toBe('routed');
    expect(await routed.complete(fakeReq('generateProductionPrompt'))).toBe('BG');
    expect(await routed.complete(fakeReq('judgeDuplicateMeaning'))).toBe('BG');
    expect(await routed.complete(fakeReq('checkProduction'))).toBe('MAIN');
    expect(main.tasks).toEqual(['checkProduction']);
    expect(bg.tasks).toEqual(['generateProductionPrompt', 'judgeDuplicateMeaning']);
  });

  it('resolveModelForTask：background 任务解析后台槽模型（显式配置直取，无网络发现）', async () => {
    clearModelsCacheForTests();
    const config = {
      ...configWithBg({
        aiBgApiKey: 'bg-key',
        aiBgModels: { flash: 'glm-5.3-flash', air: '', max: '' },
      }),
      glmApiKey: 'main-key',
      glmModels: { flash: 'deepseek-flash', air: 'deepseek-flash', max: 'deepseek-flash' },
    };
    expect(await resolveModelForTask(config, 'generateProductionPrompt')).toBe('glm-5.3-flash');
    expect(await resolveModelForTask(config, 'checkProduction')).toBe('deepseek-flash');
    clearModelsCacheForTests();
  });
});

function fakeReq(task: AiTask): ProviderRequest {
  return { task, model: 'm', temperature: 0.5, prompt: 'p', thinking: 'off', vars: {} };
}
