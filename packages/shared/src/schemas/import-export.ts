import { z } from 'zod';
import { LearningItemType } from './learning-item.js';

/** 学习库导入/导出 JSON（PRODUCT_DESIGN §9.1） */
export const LibraryImportItem = z.object({
  type: LearningItemType,
  production_enabled_override: z.boolean().nullable().optional(),
  target: z.string().min(1),
  meaning: z.string().min(1),
  ipa: z.string().nullable().optional(),
  source_example: z.string().min(1),
  /** 可选原句中文译文；缺省/null/空白兼容旧学习库。 */
  source_example_translation: z.string().nullable().optional(),
  extra_examples: z.array(z.string().min(1)).max(10).default([]),
  source: z.string().nullable().optional(),
  source_url: z.string().nullable().optional(),
  tags: z.array(z.string().min(1)).default([]),
  notes: z.string().nullable().optional(),
});
export type LibraryImportItem = z.infer<typeof LibraryImportItem>;

export const LibraryImport = z.object({
  version: z.enum(['1.2', '2.0']),
  items: z.array(LibraryImportItem).min(1),
});
export type LibraryImport = z.infer<typeof LibraryImport>;

/** 导入重复处理决策 */
export const DuplicateDecision = z.enum(['merge', 'new_item', 'skip_exact_duplicate']);
export type DuplicateDecision = z.infer<typeof DuplicateDecision>;

// 完整备份 JSON 契约见 schemas/api/backup.ts（Phase 6 冻结为精确类型）
