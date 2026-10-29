import { z } from 'zod';

export const ExampleKind = z.enum(['source', 'extra', 'personal']);
export type ExampleKind = z.infer<typeof ExampleKind>;

export const LearningExample = z.object({
  id: z.string().min(1),
  learningItemId: z.string().min(1),
  kind: ExampleKind,
  /** personal 为 corrected 版本；source/extra 为原文 */
  text: z.string().min(1),
  /** 与本句对应的已保存中文译文；旧例句可缺省。 */
  translation: z.string().nullable().optional(),
  originalText: z.string().nullable(),
  betterText: z.string().nullable(),
  /** 仅 personal 有效 */
  pinned: z.number().int().min(0).max(1),
  qualityScore: z.number().min(0).max(1).nullable(),
  sortOrder: z.number().int(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type LearningExample = z.infer<typeof LearningExample>;

export const ExampleInput = z.object({
  text: z.string().min(1),
  originalText: z.string().nullable().optional(),
  betterText: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
  qualityScore: z.number().min(0).max(1).nullable().optional(),
});
export type ExampleInput = z.infer<typeof ExampleInput>;
