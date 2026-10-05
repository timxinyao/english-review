import type { AiTask, ThinkingLevel } from '@el/shared';
import type { AppConfig } from '../config.js';
import { FALLBACK_MODELS } from './models.js';

export type ModelAlias = 'flash' | 'air' | 'max';

interface TaskModelPolicy {
  alias: ModelAlias;
  temperature: number;
  /** 任务级思考强度默认（GLM_THINKING 未设置时生效） */
  thinking: ThinkingLevel;
  /** 任务级请求超时（缺省 provider 默认 120s）；超时仅重试一次 */
  timeoutMs?: number;
  /**
   * 任务级端到端预算：completeStructured 全部 attempt（含 provider 内部超时重试）的总耗时上限，
   * 耗尽即停止重试按失败返回。必须 < nginx proxy_read_timeout 180s 与前端 api() 100s 请求中止
   * （apps/web/src/lib/api.ts），防 504 / 客户端挂死；缺省不设（行为不变）。
   */
  totalBudgetMs?: number;
}

export const THINKING_BUDGET_TOKENS: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  low: 2048,
  medium: 4096,
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
  checkCloze: { alias: 'flash', temperature: 0.1, thinking: 'off' },
  generateProductionPrompt: { alias: 'flash', temperature: 0.8, thinking: 'off' },
  // 批改是唯一 main+思考组合：基准实测 main+medium=100%·14s，flash 各档最高 89% 且更慢，
  // off 档两模型均 67%（docs/MODEL_BENCHMARK.md）
  // timeoutMs：2026-10-03 基准 avg 15s 但长尾 max 37s、偶发 120s provider 超时——
  // 收紧到 35s，超时仅重试一次（防长尾干等、防无限重试）
  // totalBudgetMs：2026-10-04 事故——35s×2（provider 内重试）×3（结构化重试）≈210s 最坏路径
  // 超 nginx 180s → 504 且零写入。端到端预算 80s 必须保持 < nginx 180s 与前端 100s 中止。
  checkProduction: {
    alias: 'max',
    temperature: 0.2,
    thinking: 'medium',
    timeoutMs: 35_000,
    totalBudgetMs: 80_000,
  },
  generateRead: { alias: 'flash', temperature: 0.8, thinking: 'off' },
  judgeDuplicateMeaning: { alias: 'flash', temperature: 0.2, thinking: 'low' },
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
