import type { AiTask, ThinkingLevel } from '@el/shared';
import type { AppConfig } from '../config.js';
import { FALLBACK_MODELS } from './models.js';

export type ModelAlias = 'flash' | 'air' | 'max';

interface TaskModelPolicy {
  alias: ModelAlias;
  temperature: number;
  /** 任务级思考强度默认（GLM_THINKING 未设置时生效） */
  thinking: ThinkingLevel;
}

export const THINKING_BUDGET_TOKENS: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  low: 2048,
  high: 6144,
  max: 16384,
};

/**
 * 任务级模型策略（TECHNICAL_DESIGN §10.5）。
 * 判定/批改类默认 low 思考（质量优先，实测延迟可接受）；生成类默认 off（速度优先）。
 * GLM_THINKING 可全局强制 off/low/high。
 */
export const TASK_MODEL_POLICY: Record<AiTask, TaskModelPolicy> = {
  generateUnderstandingQuestions: { alias: 'flash', temperature: 0.7, thinking: 'off' },
  generateClozeQuestions: { alias: 'flash', temperature: 0.7, thinking: 'off' },
  checkCloze: { alias: 'air', temperature: 0.1, thinking: 'low' },
  generateProductionPrompt: { alias: 'flash', temperature: 0.8, thinking: 'off' },
  checkProduction: { alias: 'air', temperature: 0.2, thinking: 'low' },
  generateRead: { alias: 'air', temperature: 0.8, thinking: 'off' },
  judgeDuplicateMeaning: { alias: 'air', temperature: 0.2, thinking: 'low' },
};

/** 解析任务最终思考档位：GLM_THINKING 强制值 > 任务策略 */
export function resolveThinking(task: AiTask, config: AppConfig): ThinkingLevel {
  return config.glmThinking ?? TASK_MODEL_POLICY[task].thinking;
}

export const MAX_STRUCTURED_RETRIES = 2;

export interface ResolvedTaskConfig {
  model: string;
  temperature: number;
  maxRetries: number;
}

/**
 * 同步版：仅供展示/日志的快速回退（未做自动发现，直接用 env 或 fallback）。
 * 实际调用请用 ai/models.ts 的 resolveModelForTask（自动发现 + 缓存）。
 */
export function getTaskConfig(task: AiTask, config: AppConfig): ResolvedTaskConfig {
  const policy = TASK_MODEL_POLICY[task];
  const explicit = config.glmModels[policy.alias].trim();
  return {
    model: explicit || FALLBACK_MODELS[policy.alias],
    temperature: policy.temperature,
    maxRetries: MAX_STRUCTURED_RETRIES,
  };
}
