import { z } from 'zod';

/** 模型来源：auto=自动发现最新；config=环境变量指定；fallback=发现失败用内置默认 */
export const AiModelSource = z.enum(['auto', 'config', 'fallback']);
export type AiModelSource = z.infer<typeof AiModelSource>;

/** 思考强度：off=不启用；low≈2k / medium≈4k / high≈6k / max≈16k tokens 思考预算 */
export const ThinkingLevel = z.enum(['off', 'low', 'medium', 'high', 'max']);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

export const AiModelInfo = z.object({
  model: z.string().min(1),
  source: AiModelSource,
  /** 显式指定的模型是否在可用清单中（auto/fallback 恒 true） */
  inList: z.boolean(),
  /** 该用途当前生效的思考强度 */
  thinking: ThinkingLevel,
});
export type AiModelInfo = z.infer<typeof AiModelInfo>;

/** provider 槽：main=实时（GLM_* 槽）；background=批量/不敏感（AI_BG_* 槽，未配置时回落 main） */
export const AiProviderSlot = z.enum(['main', 'background']);
export type AiProviderSlot = z.infer<typeof AiProviderSlot>;

export const AiModelsResponse = z.object({
  provider: z.string(),
  models: z.object({
    flash: AiModelInfo,
    air: AiModelInfo,
    max: AiModelInfo,
  }),
  /** 后台槽是否已配置（AI_BG_API_KEY 非空）：false 时所有任务走主槽 */
  backgroundConfigured: z.boolean(),
  /** 环境变量 GLM_THINKING 的全局强制档位（null=未设置，按任务策略） */
  thinkingOverride: ThinkingLevel.nullable(),
  /** 每个任务实际使用的别名、模型与 provider 槽 */
  taskMapping: z.array(
    z.object({
      task: z.string(),
      alias: z.enum(['flash', 'air', 'max']),
      model: z.string(),
      thinking: ThinkingLevel,
      provider: AiProviderSlot,
    }),
  ),
  /** 发现到的可用模型清单（发现失败为空数组） */
  availableModels: z.array(z.string()),
  checkedAt: z.string().nullable(),
});
export type AiModelsResponse = z.infer<typeof AiModelsResponse>;
