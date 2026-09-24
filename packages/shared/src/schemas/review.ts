import { z } from 'zod';

export const ReviewDimension = z.enum(['understanding', 'production']);
export type ReviewDimension = z.infer<typeof ReviewDimension>;

/** 答题结果（业务层最终判定） */
export const AnswerResult = z.enum(['pass', 'basic_pass', 'fail', 'void']);
export type AnswerResult = z.infer<typeof AnswerResult>;

/** 用户附加反馈 */
export const AnswerFeedback = z.enum(['guessed', 'too_easy']);
export type AnswerFeedback = z.infer<typeof AnswerFeedback>;

export const ReviewState = z.object({
  id: z.string().min(1),
  learningItemId: z.string().min(1),
  dimension: ReviewDimension,
  /** 0=未激活，1..7=L1..L7 */
  level: z.number().int().min(0).max(7),
  stable: z.number().int().min(0).max(1),
  nextReviewAt: z.string().nullable(),
  lastReviewAt: z.string().nullable(),
  correctStreak: z.number().int(),
  wrongStreak: z.number().int(),
  updatedAt: z.string().min(1),
});
export type ReviewState = z.infer<typeof ReviewState>;
