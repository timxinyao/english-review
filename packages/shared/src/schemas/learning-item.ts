import { z } from 'zod';

export const LearningItemType = z.enum(['word', 'chunk']);
export type LearningItemType = z.infer<typeof LearningItemType>;

export const LearningItemStatus = z.enum(['active', 'mastered', 'paused', 'archived']);
export type LearningItemStatus = z.infer<typeof LearningItemStatus>;

export const QueueState = z.enum(['new', 'started']);
export type QueueState = z.infer<typeof QueueState>;

const isoDateTime = z.string().min(1);

export const LearningItem = z.object({
  id: z.string().min(1),
  type: LearningItemType,
  productionEnabledOverride: z.boolean().nullable(),
  productionEnabled: z.boolean(),
  target: z.string().min(1),
  meaning: z.string().min(1),
  /** 仅 word；chunk 恒为 null */
  ipa: z.string().nullable(),
  source: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  /** JSON array 字符串（DB 存储形态）；TS 层使用 parseTags() */
  tagsJson: z.string(),
  notes: z.string().nullable(),
  status: LearningItemStatus,
  queueState: QueueState,
  needsReinforcement: z.number().int().min(0).max(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  archivedAt: isoDateTime.nullable(),
});
export type LearningItem = z.infer<typeof LearningItem>;

export const Tags = z.array(z.string().min(1));
export type Tags = z.infer<typeof Tags>;

export function parseTags(tagsJson: string): Tags {
  const parsed = Tags.safeParse(JSON.parse(tagsJson));
  return parsed.success ? parsed.data : [];
}

export function serializeTags(tags: Tags): string {
  return JSON.stringify(tags);
}
