import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { loadPromptRegistry } from '../../src/ai/promptRegistry.js';
import { createMockProvider } from '../../src/ai/provider/index.js';
import type { AiProvider, ProviderRequest } from '../../src/ai/provider/index.js';
import type { AiRuntime } from '../../src/ai/runtime.js';

/** 测试用 AI 配置（不读 process.env，保证确定性） */
export function testAiConfig() {
  return loadConfig({
    SESSION_SECRET: 'unit-test-secret-0123456789abcdef',
    AUTH_PASSWORD: 'unit-test-password',
  } as Record<string, string | undefined>);
}

/** 组装可注入的测试 runtime（默认 mock provider + 真实 Prompt Registry） */
export function buildMockRuntime(provider: AiProvider = createMockProvider()): AiRuntime {
  return {
    config: testAiConfig(),
    provider,
    registry: loadPromptRegistry(join(process.cwd(), 'prompts')),
    judgeDuplicateMeaning: async () => {
      throw new Error('测试中不应调用 judgeDuplicateMeaning');
    },
  };
}

/** 记录渲染后 Prompt 正文的包装 provider（透传给内层 provider） */
export function recordingProvider(inner: AiProvider): {
  provider: AiProvider;
  prompts: string[];
} {
  const prompts: string[] = [];
  return {
    prompts,
    provider: {
      name: inner.name,
      async complete(req: ProviderRequest) {
        prompts.push(req.prompt);
        return inner.complete(req);
      },
    },
  };
}

/** 对指定 target 抛错、其余透传 mock 的 provider（测试失败隔离） */
export function failingForTargetProvider(failTarget: string): AiProvider {
  const inner = createMockProvider();
  return {
    name: inner.name,
    async complete(req: ProviderRequest) {
      if (
        req.vars.target === failTarget ||
        (Array.isArray(req.vars.targets) &&
          req.vars.targets.some((t: { target?: string }) => t.target === failTarget))
      )
        throw new Error(`模拟生成失败：${failTarget}`);
      return inner.complete(req);
    },
  };
}

/** 始终抛错的 provider（测试失败不入库） */
export function throwingProvider(): AiProvider {
  return {
    name: 'glm',
    async complete() {
      throw new Error('模拟 provider 故障');
    },
  };
}

/** 返回固定 JSON 的伪 glm provider（测试 checkCloze AI 兜底默认路径） */
export function fakeGlmProvider(rawJson: string): AiProvider {
  return {
    name: 'glm',
    async complete() {
      return rawJson;
    },
  };
}
