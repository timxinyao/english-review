import { z } from 'zod';

/** 模型来源：auto=自动发现最新；config=环境变量指定；fallback=发现失败用内置默认 */
export const AiModelSource = z.enum(['auto', 'config', 'fallback']);
export type AiModelSource = z.infer<typeof AiModelSource>;

export const AiModelInfo = z.object({
  model: z.string().min(1),
  source: AiModelSource,
  /** 显式指定的模型是否在可用清单中（auto/fallback 恒 true） */
  inList: z.boolean(),
});
export type AiModelInfo = z.infer<typeof AiModelInfo>;

export const AiModelsResponse = z.object({
  provider: z.string(),
  models: z.object({
    flash: AiModelInfo,
    air: AiModelInfo,
    max: AiModelInfo,
  }),
  /** 每个任务实际使用的别名与模型 */
  taskMapping: z.array(
    z.object({
      task: z.string(),
      alias: z.enum(['flash', 'air', 'max']),
      model: z.string(),
    }),
  ),
  /** 发现到的可用模型清单（发现失败为空数组） */
  availableModels: z.array(z.string()),
  checkedAt: z.string().nullable(),
});
export type AiModelsResponse = z.infer<typeof AiModelsResponse>;
