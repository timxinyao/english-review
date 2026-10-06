import type { AiTask } from '@el/shared';
import type { AppConfig } from '../../config.js';
import { createGlmProvider } from './glm.js';
import { createMockProvider } from './mock.js';
import { providerSlotForTask } from '../taskConfig.js';

export interface ProviderRequest {
  task: AiTask;
  model: string;
  temperature: number;
  /** 渲染后的完整 Prompt 正文 */
  prompt: string;
  /** 思考强度（off 时省略 thinking 参数） */
  thinking: 'off' | 'low' | 'medium' | 'high' | 'max';
  /** 原始结构化变量（供 mock provider 生成确定性输出；GLM 忽略） */
  vars: Record<string, unknown>;
  /** 任务级请求超时（缺省用 provider 默认 120s）；仅超时错误会重试一次 */
  timeoutMs?: number;
}

export interface AiProvider {
  readonly name: 'glm' | 'mock' | 'routed';
  complete(req: ProviderRequest): Promise<string>;
}

export { createGlmProvider, createMockProvider };

export function resolveProvider(kind: 'mock' | 'glm' | 'auto', config: AppConfig): AiProvider {
  if (kind === 'mock') return createMockProvider();
  if (kind === 'glm') {
    if (!config.glmApiKey) throw new Error('GLM_API_KEY 未设置，无法使用 glm provider');
    return createGlmProvider(config);
  }
  return config.glmApiKey ? createGlmProvider(config) : createMockProvider();
}

/**
 * 主槽 + 后台槽路由 provider（2026-10-06）：按任务策略把 background 任务（预取生成/
 * 导入查重，速度不敏感）送到 AI_BG_* 槽（GLM 免费套餐），实时任务走 GLM_* 主槽。
 * 后台槽未配 key、或主 provider 是 mock（测试管线，生产守卫禁止 mock 与真实 AI 混跑）
 * 时原样返回 main。模型名由 resolveModelForTask 按同一判路由，与本包装器天然一致。
 * main/bg 可注入（测试用假 provider 断言路由）。
 */
export function createRoutingProvider(
  config: AppConfig,
  main: AiProvider = resolveProvider('auto', config),
  bg: AiProvider | null = config.aiBgApiKey
    ? createGlmProvider({
        ...config,
        glmApiKey: config.aiBgApiKey,
        glmApiBase: config.aiBgApiBase,
        glmModels: config.aiBgModels,
      })
    : null,
): AiProvider {
  if (!bg || main.name === 'mock') return main;
  return {
    name: 'routed',
    complete(req: ProviderRequest) {
      return (providerSlotForTask(req.task, config) === 'background' ? bg : main).complete(req);
    },
  };
}
