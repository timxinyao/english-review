import { z } from 'zod';
import { CONTENT_LEVELS } from '../../constants/app.js';
import { MaxNewItemsPerDay, Settings, TodayReviewLimit } from '../settings.js';

export { Settings };

export const UpdateSettingsRequest = z.object({
  maxNewItemsPerDay: MaxNewItemsPerDay.optional(),
  todayReviewLimit: TodayReviewLimit.optional(),
  contentLevel: z.enum(CONTENT_LEVELS).optional(),
  preferredTtsVoice: z.string().nullable().optional(),
});
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequest>;
