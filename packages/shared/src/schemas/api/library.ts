import { z } from 'zod';
import { LearningItemStatus, LearningItemType } from '../learning-item.js';

// ---------- 列表 ----------

export const LibraryListQuery = z.object({
  query: z.string().optional(),
  type: LearningItemType.optional(),
  status: LearningItemStatus.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type LibraryListQuery = z.infer<typeof LibraryListQuery>;

export const LibraryListItemDto = z.object({
  id: z.string(),
  type: LearningItemType,
  productionEnabledOverride: z.boolean().nullable(),
  productionEnabled: z.boolean(),
  target: z.string(),
  meaning: z.string(),
  status: LearningItemStatus,
  queueState: z.enum(['new', 'started']),
  tags: z.array(z.string()),
  source: z.string().nullable(),
  /** 自然语言阶段：未开始 / 初学 / 练习中 / 稳定 */
  understandingStage: z.string(),
  productionStage: z.string(),
  /** 两维度中最近的到期时间 */
  nextReviewAt: z.string().nullable(),
  createdAt: z.string(),
});
export type LibraryListItemDto = z.infer<typeof LibraryListItemDto>;

export const LibraryListResponse = z.object({
  items: z.array(LibraryListItemDto),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type LibraryListResponse = z.infer<typeof LibraryListResponse>;

// ---------- 详情 ----------

export const PersonalExampleDto = z.object({
  id: z.string(),
  text: z.string(),
  originalText: z.string().nullable(),
  betterText: z.string().nullable(),
  pinned: z.boolean(),
});
export type PersonalExampleDto = z.infer<typeof PersonalExampleDto>;

export const ReviewStateDto = z.object({
  dimension: z.enum(['understanding', 'production']),
  level: z.number().int(),
  stable: z.boolean(),
  nextReviewAt: z.string().nullable(),
  lastReviewAt: z.string().nullable(),
});
export type ReviewStateDto = z.infer<typeof ReviewStateDto>;

export const LibraryItemDetail = z.object({
  item: z.object({
    id: z.string(),
    type: LearningItemType,
    productionEnabledOverride: z.boolean().nullable(),
    productionEnabled: z.boolean(),
    target: z.string(),
    meaning: z.string(),
    ipa: z.string().nullable(),
    source: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    tags: z.array(z.string()),
    notes: z.string().nullable(),
    status: LearningItemStatus,
    queueState: z.enum(['new', 'started']),
    needsReinforcement: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    archivedAt: z.string().nullable(),
  }),
  sourceExample: z.string(),
  extraExamples: z.array(z.string()),
  personalExamples: z.array(PersonalExampleDto),
  reviewStates: z.array(ReviewStateDto),
  /** 近期造句历史（每项最多保留 10 次，PRODUCT §7.5），按时间倒序 */
  productionHistory: z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      originalText: z.string().nullable(),
      correctedSentence: z.string().nullable(),
      betterVersion: z.string().nullable(),
      result: z.enum(['pass', 'basic_pass', 'fail', 'void']),
      mode: z.enum(['today', 'library_practice']),
    }),
  ),
});
export type LibraryItemDetail = z.infer<typeof LibraryItemDetail>;

// ---------- 编辑 ----------

export const UpdateLearningItemRequest = z.object({
  type: LearningItemType.optional(),
  productionEnabledOverride: z.boolean().nullable().optional(),
  target: z.string().min(1).optional(),
  meaning: z.string().min(1).optional(),
  ipa: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
  notes: z.string().nullable().optional(),
  sourceExample: z.string().min(1).optional(),
  extraExamples: z.array(z.string().min(1)).optional(),
  personalExamples: z
    .array(
      z.object({
        id: z.string(),
        pinned: z.boolean().optional(),
        text: z.string().min(1).optional(),
      }),
    )
    .optional(),
});
export type UpdateLearningItemRequest = z.infer<typeof UpdateLearningItemRequest>;

/** meaning 变化时后端返回建议标记，由用户决定是否调用 reset */
export const UpdateLearningItemResponse = LibraryItemDetail.extend({
  progressResetSuggested: z.boolean(),
});
export type UpdateLearningItemResponse = z.infer<typeof UpdateLearningItemResponse>;
