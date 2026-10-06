import type { AiTask, ThinkingLevel } from '@el/shared';
import type { AppConfig } from '../config.js';
import { FALLBACK_MODELS } from './models.js';

export type ModelAlias = 'flash' | 'air' | 'max';

interface TaskModelPolicy {
  alias: ModelAlias;
  /** provider 槽路由（2026-10-06）：background=批量/速度不敏感任务走 AI_BG_* 槽
   *  （GLM 免费套餐），main=实时交互走 GLM_* 槽（DeepSeek）。缺省 main；
   *  后台槽未配置 key 时自动回落 main（provider 路由与 models 解析同判）。 */
  provider?: 'main' | 'background';
  temperature: number;
  /** 任务级思考强度默认（GLM_THINKING 未设置时生效） */
  thinking: ThinkingLevel;
  /** 任务级请求超时（缺省 provider 默认 120s）；超时仅重试一次 */
  timeoutMs?: number;
  /**
   * 任务级端到端预算：completeStructured 全部 attempt（含 provider 内部超时重试）的总耗时上限，
   * 耗尽即停止重试按失败返回。必须 < nginx proxy_read_timeout 180s 与前端 api() 150s 请求中止
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
  // 生成类走后台槽（GLM 免费套餐，预取/懒生成对速度不敏感；2026-10-06）。后台槽用
  // glm-5.3 主模型（alias max）：免费额度内对比实测主模型 off 档全线 100% 且最快
  // （judge 9/9·3.1s、理解题 4/4·7.1s、填空 4/4·4.6s）；flash off 有错、思考档 65-104s 出局
  generateUnderstandingQuestions: {
    alias: 'max',
    provider: 'background',
    temperature: 0.7,
    thinking: 'off',
  },
  generateClozeQuestions: {
    alias: 'max',
    provider: 'background',
    temperature: 0.7,
    thinking: 'off',
  },
  checkCloze: { alias: 'flash', temperature: 0.1, thinking: 'off' },
  generateProductionPrompt: {
    alias: 'max',
    provider: 'background',
    temperature: 0.8,
    thinking: 'off',
  },
  // 批改（2026-10-06 切 DeepSeek flash）：flash+max = 42/42=100% · avg 13.8s · p50 6.3s。
  // DeepSeek 端点忽略 budget_tokens，档位差异只来自 max_tokens 上限（budget+GLM_MAX_TOKENS）：
  // max 档上限 24576，消灭 low/medium/high 思考打满上限的「缺文本」失败（93-95%）。
  // prompt v3 加思考纪律（一次定案）后疑难句尾巴 65-79s→37-65s（中位 ~48s）——
  // timeoutMs 60s：attempt1=min(60, 预算/2)=60s 覆盖中位，cp13 型 5/6 直接批出；
  // 35s 旧值会把此类句子判死（手动重试同样被截断，永远无法批改）。
  // totalBudgetMs 120s：2026-10-04 504 事故约束最坏重试路径 < nginx 180s；
  // 前端中止已同步放宽到 150s（apps/web/src/lib/api.ts），预算仍留 30s 余量。
  checkProduction: {
    alias: 'flash',
    temperature: 0.2,
    thinking: 'max',
    timeoutMs: 60_000,
    totalBudgetMs: 120_000,
  },
  // generateRead 实时（Read 页点按钮等待）→ 主槽 DeepSeek
  generateRead: { alias: 'flash', temperature: 0.8, thinking: 'off' },
  // 导入查重（速度不敏感）→ 后台槽 glm-5.3。off 即 9/9=100% · 3.1s（2026-10-06 实测，
  // 主模型无需思考；此前 low 是为 flash 补的）；回落 DeepSeek 主槽时 off 亦 9/9=100%
  judgeDuplicateMeaning: {
    alias: 'max',
    provider: 'background',
    temperature: 0.2,
    thinking: 'off',
  },
};

/** 解析任务最终思考档位：GLM_THINKING 强制值 > 任务策略 */
export function resolveThinking(task: AiTask, config: AppConfig): ThinkingLevel {
  return config.glmThinking ?? TASK_MODEL_POLICY[task].thinking;
}

/**
 * 任务路由到的 provider 槽：background 任务在后台槽配了 key 时走后台，
 * 否则（含 main 任务）回落主槽。provider 路由与 models 解析共用此判。
 */
export function providerSlotForTask(
  task: AiTask,
  config: Pick<AppConfig, 'aiBgApiKey'>,
): 'main' | 'background' {
  return TASK_MODEL_POLICY[task].provider === 'background' && config.aiBgApiKey
    ? 'background'
    : 'main';
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
