import { z } from 'zod';

export const TaskType = z.enum(['understanding', 'cloze', 'production', 'learn']);
export type TaskType = z.infer<typeof TaskType>;

export const TaskOrigin = z.enum(['base', 'reinforcement', 'read_reinforcement']);
export type TaskOrigin = z.infer<typeof TaskOrigin>;

export const ReviewSession = z.object({
  id: z.string().min(1),
  /** 用户本地日期 YYYY-MM-DD */
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startedAt: z.string().min(1),
  completedAt: z.string().nullable(),
  baseTaskCount: z.number().int().min(0),
  newItemsStarted: z.number().int().min(0),
  createdAt: z.string().min(1),
});
export type ReviewSession = z.infer<typeof ReviewSession>;

export const ReviewTask = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  learningItemId: z.string().min(1),
  dimension: z.enum(['understanding', 'production']),
  questionId: z.string().nullable(),
  taskType: TaskType,
  origin: TaskOrigin,
  sortKey: z.number(),
  deferCount: z.number().int().min(0),
  completedAt: z.string().nullable(),
  canceledAt: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type ReviewTask = z.infer<typeof ReviewTask>;
