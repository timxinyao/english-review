import { z } from 'zod';
import { CONTENT_LEVELS, DEFAULT_CONTENT_LEVEL } from '../constants/app.js';
import {
  DEFAULT_MAX_NEW_ITEMS_PER_DAY,
  MAX_NEW_ITEMS_CHOICES,
  MAX_NEW_ITEMS_UNLIMITED,
} from '../constants/review.js';

export const MaxNewItemsPerDay = z
  .number()
  .int()
  .refine(
    (v) => v === MAX_NEW_ITEMS_UNLIMITED || (MAX_NEW_ITEMS_CHOICES as readonly number[]).includes(v),
    { message: `必须是 ${MAX_NEW_ITEMS_CHOICES.join('/')} 或 ${MAX_NEW_ITEMS_UNLIMITED}（不限制）` },
  );
export type MaxNewItemsPerDay = z.infer<typeof MaxNewItemsPerDay>;

export const Settings = z.object({
  maxNewItemsPerDay: MaxNewItemsPerDay,
  contentLevel: z.enum(CONTENT_LEVELS),
  preferredTtsVoice: z.string().nullable(),
  updatedAt: z.string().min(1),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS = {
  maxNewItemsPerDay: DEFAULT_MAX_NEW_ITEMS_PER_DAY,
  contentLevel: DEFAULT_CONTENT_LEVEL,
  preferredTtsVoice: null,
} as const;
