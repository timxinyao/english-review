import { z } from 'zod';

export const ReadItemRole = z.enum(['focus', 'old']);
export type ReadItemRole = z.infer<typeof ReadItemRole>;

export const ReadArticle = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  contentLevel: z.string().min(1),
  favorite: z.number().int().min(0).max(1),
  promptKey: z.string().min(1),
  promptVersion: z.number().int().min(1),
  promptHash: z.string().min(1),
  model: z.string().min(1),
  createdAt: z.string().min(1),
  expiresAt: z.string().nullable(),
});
export type ReadArticle = z.infer<typeof ReadArticle>;

export const ReadArticleItem = z.object({
  readArticleId: z.string().min(1),
  learningItemId: z.string().min(1),
  role: ReadItemRole,
  highlighted: z.number().int().min(0).max(1),
});
export type ReadArticleItem = z.infer<typeof ReadArticleItem>;
