import { z } from 'zod';

/** GET /api/stats（PRODUCT §5.4：少量长期有意义的数据 + 12 个月热力图） */
export const StatsResponse = z.object({
  totals: z.object({
    items: z.number().int(),
    words: z.number().int(),
    chunks: z.number().int(),
    active: z.number().int(),
    mastered: z.number().int(),
    paused: z.number().int(),
    archived: z.number().int(),
    newQueue: z.number().int(),
  }),
  /** 最近 7 天完成的正式 Today 任务数（daily_stats 汇总） */
  last7DaysFormalTasks: z.number().int(),
  /** 表达题通过率（历史累计正式表达作答；无作答时为 null） */
  productionAttempts: z.number().int(),
  productionPass: z.number().int(),
  productionPassRate: z.number().min(0).max(1).nullable(),
  /** 最近 30 天新增学习项（learning_items.created_at） */
  last30DaysNewItems: z.number().int(),
  /** 12 个月热力图：以今天（APP_TIMEZONE）结尾的 365 天，零填充，旧→新 */
  heatmap: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      count: z.number().int().min(0),
    }),
  ),
});
export type StatsResponse = z.infer<typeof StatsResponse>;
