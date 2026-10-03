import { z } from 'zod';
import { CONTENT_LEVELS } from '../../constants/app.js';
import {
  DEFAULT_MAX_NEW_ITEMS_PER_DAY,
  MAX_NEW_ITEMS_CHOICES,
  MAX_NEW_ITEMS_UNLIMITED,
} from '../../constants/review.js';
import { LearningItemStatus, LearningItemType, QueueState } from '../learning-item.js';

// ---------- 完整备份 JSON（覆盖式恢复用，含进度与聚合；不含 AI 缓存题目/Read）----------

export const BackupExample = z.object({
  kind: z.enum(['source', 'extra', 'personal']),
  text: z.string().min(1),
  originalText: z.string().nullable().optional(),
  betterText: z.string().nullable().optional(),
  pinned: z.number().int().min(0).max(1).optional(),
  qualityScore: z.number().min(0).max(1).nullable().optional(),
  sortOrder: z.number().int().optional(),
});
export type BackupExample = z.infer<typeof BackupExample>;

export const BackupReviewState = z.object({
  dimension: z.enum(['understanding', 'production']),
  /** 旧备份（FSRS 前）字段：恢复时忽略，进度回放见 Task 3 */
  level: z.number().int().min(0).max(7).optional(),
  stable: z.number().int().min(0).max(1).optional(),
  /** FSRS 字段（2.1 备份起）；旧备份缺省 → 未激活 */
  difficulty: z.number().nullable().optional(),
  stability: z.number().nullable().optional(),
  reps: z.number().int().min(0).optional(),
  lapses: z.number().int().min(0).optional(),
  nextReviewAt: z.string().nullable(),
  lastReviewAt: z.string().nullable(),
  correctStreak: z.number().int(),
  wrongStreak: z.number().int(),
});
export type BackupReviewState = z.infer<typeof BackupReviewState>;

const BackupItemBase = z.object({
  id: z.string().min(1),
  type: LearningItemType,
  target: z.string().min(1),
  meaning: z.string().min(1),
  ipa: z.string().nullable(),
  source: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  status: LearningItemStatus,
  queueState: QueueState,
  needsReinforcement: z.number().int().min(0).max(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  archivedAt: z.string().nullable(),
  examples: z.array(BackupExample),
  reviewStates: z.array(BackupReviewState),
});
export const BackupItem = BackupItemBase.extend({
  productionEnabledOverride: z.boolean().nullable(),
});
export type BackupItem = z.infer<typeof BackupItem>;

export const BackupSettings = z.object({
  maxNewItemsPerDay: z
    .number()
    .int()
    .refine(
      (v) =>
        v === MAX_NEW_ITEMS_UNLIMITED || (MAX_NEW_ITEMS_CHOICES as readonly number[]).includes(v),
      { message: '每日新学额度非法' },
    ),
  contentLevel: z.enum(CONTENT_LEVELS),
  preferredTtsVoice: z.string().nullable(),
});
export type BackupSettings = z.infer<typeof BackupSettings>;

export const BackupDailyStats = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  formalTasksCompleted: z.number().int().min(0),
  newItemsStarted: z.number().int().min(0),
  productionAttempts: z.number().int().min(0),
  productionPass: z.number().int().min(0),
});
export type BackupDailyStats = z.infer<typeof BackupDailyStats>;

const BackupExportBase = z.object({
  exportedAt: z.string().min(1),
  settings: BackupSettings,
  dailyStats: z.array(BackupDailyStats),
});
export const BackupExport = z.discriminatedUnion('version', [
  BackupExportBase.extend({ version: z.literal('1.2'), items: z.array(BackupItemBase) }),
  BackupExportBase.extend({ version: z.literal('2.0'), items: z.array(BackupItem) }),
]);
export type BackupExport = z.infer<typeof BackupExport>;

// ---------- 恢复：预览（上传备份 JSON）→ 二次确认提交 ----------

export const RestorePreviewResponse = z.object({
  previewToken: z.string().min(1),
  /** 备份内信息 */
  exportedAt: z.string(),
  itemCount: z.number().int(),
  dailyStatsDays: z.number().int(),
  /** 当前库信息 */
  currentItemTotal: z.number().int(),
  /** 非阻断性警告（如备份额度取值、时区变化提示） */
  warnings: z.array(z.string()),
});
export type RestorePreviewResponse = z.infer<typeof RestorePreviewResponse>;

export const RestoreCommitRequest = z.object({
  previewToken: z.string().min(1),
});
export type RestoreCommitRequest = z.infer<typeof RestoreCommitRequest>;

export const RestoreCommitResponse = z.object({
  ok: z.literal(true),
  restoredItems: z.number().int(),
  restoredDailyStats: z.number().int(),
  /** 恢复前自动创建的当前库快照文件名 */
  snapshotFile: z.string(),
});
export type RestoreCommitResponse = z.infer<typeof RestoreCommitResponse>;

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  maxNewItemsPerDay: DEFAULT_MAX_NEW_ITEMS_PER_DAY,
  contentLevel: 'B1',
  preferredTtsVoice: null,
};
