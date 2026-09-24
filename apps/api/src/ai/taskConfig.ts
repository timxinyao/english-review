import type { AiTask } from '@el/shared';
import type { AppConfig } from '../config.js';

export type ModelAlias = 'flash' | 'air' | 'max';

interface TaskModelPolicy {
  alias: ModelAlias;
  temperature: number;
}

/**
 * 任务级模型策略（TECHNICAL_DESIGN §10.5：模型与采样参数在 Git 中按 task 管理）。
 * 生成类用 flash；判断/批改类用 air 以获得更稳定的质量。
 */
export const TASK_MODEL_POLICY: Record<AiTask, TaskModelPolicy> = {
  generateUnderstandingQuestions: { alias: 'flash', temperature: 0.7 },
  generateClozeQuestions: { alias: 'flash', temperature: 0.7 },
  checkCloze: { alias: 'air', temperature: 0.1 },
  generateProductionPrompt: { alias: 'flash', temperature: 0.8 },
  checkProduction: { alias: 'air', temperature: 0.2 },
  generateRead: { alias: 'air', temperature: 0.8 },
  judgeDuplicateMeaning: { alias: 'air', temperature: 0.2 },
};

export const MAX_STRUCTURED_RETRIES = 2;

export interface ResolvedTaskConfig {
  model: string;
  temperature: number;
  maxRetries: number;
}

export function getTaskConfig(task: AiTask, config: AppConfig): ResolvedTaskConfig {
  const policy = TASK_MODEL_POLICY[task];
  return {
    model: config.glmModels[policy.alias],
    temperature: policy.temperature,
    maxRetries: MAX_STRUCTURED_RETRIES,
  };
}
