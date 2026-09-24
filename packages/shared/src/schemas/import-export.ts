import { z } from 'zod';
import { LearningItemType } from './learning-item.js';

/** 学习库导入/导出 JSON（PRODUCT_DESIGN §9.1） */
export const LibraryImportItem = z.object({
  type: LearningItemType,
  target: z.string().min(1),
  meaning: z.string().min(1),
  ipa: z.string().nullable().optional(),
  source_example: z.string().min(1),
  extra_examples: z.array(z.string().min(1)).max(10).default([]),
  source: z.string().nullable().optional(),
  source_url: z.string().nullable().optional(),
  tags: z.array(z.string().min(1)).default([]),
  notes: z.string().nullable().optional(),
});
export type LibraryImportItem = z.infer<typeof LibraryImportItem>;

export const LibraryImport = z.object({
  version: z.literal('1.2'),
  items: z.array(LibraryImportItem).min(1),
});
export type LibraryImport = z.infer<typeof LibraryImport>;

/** 导入重复处理决策 */
export const DuplicateDecision = z.enum(['merge', 'new_item', 'skip_exact_duplicate']);
export type DuplicateDecision = z.infer<typeof DuplicateDecision>;

/** 完整备份 JSON 的顶层结构（Phase 6 实现，先冻结契约） */
export const BackupExport = z.object({
  version: z.literal('1.2'),
  exportedAt: z.string().min(1),
  items: z.array(z.unknown()),
  reviewStates: z.array(z.unknown()),
  dailyStats: z.array(z.unknown()),
  settings: z.unknown(),
});
export type BackupExport = z.infer<typeof BackupExport>;
