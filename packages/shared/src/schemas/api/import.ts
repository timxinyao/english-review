import { z } from 'zod';
import { type LibraryImport, DuplicateDecision, LibraryImportItem } from '../import-export.js';

// ---------- 预览 ----------

/** 建议来源：ai=GLM 判定；rule_exact=完全重复规则；rule_fallback=AI 不可用/失败时的规则回退 */
export const SuggestionSource = z.enum(['ai', 'rule_exact', 'rule_fallback']);
export type SuggestionSource = z.infer<typeof SuggestionSource>;

export const ImportPreviewSuggestion = z.object({
  action: DuplicateDecision,
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  source: SuggestionSource,
});
export type ImportPreviewSuggestion = z.infer<typeof ImportPreviewSuggestion>;

export const ImportPreviewMatch = z.object({
  existingId: z.string(),
  existingTarget: z.string(),
  existingMeaning: z.string(),
});
export type ImportPreviewMatch = z.infer<typeof ImportPreviewMatch>;

export const ImportPreviewItem = z.object({
  /** 候选在原始 items 数组中的下标 */
  index: z.number().int().min(0),
  candidate: LibraryImportItem,
  suggestion: ImportPreviewSuggestion,
  /** 触发比对的已有项；无匹配时为 null */
  match: ImportPreviewMatch.nullable(),
});
export type ImportPreviewItem = z.infer<typeof ImportPreviewItem>;

export const ImportPreviewResponse = z.object({
  previewToken: z.string().min(1),
  items: z.array(ImportPreviewItem),
});
export type ImportPreviewResponse = z.infer<typeof ImportPreviewResponse>;

// ---------- 提交 ----------

export const ImportCommitRequest = z.object({
  previewToken: z.string().min(1),
  /** 每条候选的最终决定；空数组 = 全部沿用系统建议（CLI/脚本路径） */
  decisions: z.array(z.object({ index: z.number().int().min(0), action: DuplicateDecision })),
});
export type ImportCommitRequest = z.infer<typeof ImportCommitRequest>;

export const ImportCommitResponse = z.object({
  created: z.number().int(),
  merged: z.number().int(),
  skipped: z.number().int(),
  total: z.number().int(),
});
export type ImportCommitResponse = z.infer<typeof ImportCommitResponse>;

// ---------- 导出 ----------

/** GET /api/export/library 响应体即学习库 JSON（attachment 下载） */
export type ExportLibraryResponse = LibraryImport;
