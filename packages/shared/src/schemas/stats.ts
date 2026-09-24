import { z } from 'zod';

/** 每日聚合统计（DATABASE.md §11A） */
export const DailyStats = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  formalTasksCompleted: z.number().int().min(0),
  newItemsStarted: z.number().int().min(0),
  productionAttempts: z.number().int().min(0),
  productionPass: z.number().int().min(0),
  updatedAt: z.string().min(1),
});
export type DailyStats = z.infer<typeof DailyStats>;

export const HeatmapCell = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().min(0),
});
export type HeatmapCell = z.infer<typeof HeatmapCell>;
