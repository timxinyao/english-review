import type { AiTask } from '@el/shared';
import type { AppConfig } from '../../config.js';
import { createGlmProvider } from './glm.js';
import { createMockProvider } from './mock.js';

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
}

export interface AiProvider {
  readonly name: 'glm' | 'mock';
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
