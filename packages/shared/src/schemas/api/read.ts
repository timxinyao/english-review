import { z } from 'zod';

// ---------- Read（PRODUCT_DESIGN §8：新上下文复现，不直接改变 Stage）----------

export const ReadArticleType = z.enum(['story', 'daily_scene', 'knowledge', 'short_opinion']);
export type ReadArticleType = z.infer<typeof ReadArticleType>;

export const ReadFocusItemView = z.object({
  learningItemId: z.string(),
  target: z.string(),
  /** 该 focus 词在正文中的实际形式（用于高亮） */
  surfaceForm: z.string(),
});
export type ReadFocusItemView = z.infer<typeof ReadFocusItemView>;

export const ReadOldItemView = z.object({
  learningItemId: z.string(),
  target: z.string(),
});
export type ReadOldItemView = z.infer<typeof ReadOldItemView>;

/** 检查题视图（不含正确答案；作答由服务端判定） */
export const ReadCheckView = z.object({
  checkId: z.string(),
  learningItemId: z.string(),
  target: z.string(),
  question: z.string(),
  options: z.array(z.object({ id: z.string(), text: z.string() })).min(2),
});
export type ReadCheckView = z.infer<typeof ReadCheckView>;

export const ReadArticleView = z.object({
  id: z.string(),
  title: z.string(),
  type: ReadArticleType,
  /** 纯文本段落，\n\n 分段（AI_RULES §11：不输出 HTML/Markdown） */
  body: z.string(),
  contentLevel: z.string(),
  favorite: z.boolean(),
  createdAt: z.string(),
  /** 普通文章 created+30 天；收藏为 null（永久） */
  expiresAt: z.string().nullable(),
  focusItems: z.array(ReadFocusItemView).min(1),
  oldItems: z.array(ReadOldItemView),
  checks: z.array(ReadCheckView).min(1).max(2),
});
export type ReadArticleView = z.infer<typeof ReadArticleView>;

/** POST /api/read/generate（实时生成，响应即文章视图） */
export type ReadGenerateResponse = ReadArticleView;

// ---------- 历史 ----------

export const ReadHistoryQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  favorite: z
    .enum(['true', 'false', 'all'])
    .default('all')
    .transform((v) => (v === 'all' ? null : v === 'true')),
});
export type ReadHistoryQuery = z.infer<typeof ReadHistoryQuery>;

export const ReadHistoryItem = z.object({
  id: z.string(),
  title: z.string(),
  type: ReadArticleType,
  favorite: z.boolean(),
  createdAt: z.string(),
  wordCount: z.number().int(),
});
export type ReadHistoryItem = z.infer<typeof ReadHistoryItem>;

export const ReadHistoryResponse = z.object({
  items: z.array(ReadHistoryItem),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type ReadHistoryResponse = z.infer<typeof ReadHistoryResponse>;

// ---------- 收藏 / 检查 ----------

export const ReadFavoriteRequest = z.object({
  favorite: z.boolean(),
});
export type ReadFavoriteRequest = z.infer<typeof ReadFavoriteRequest>;

export const ReadFavoriteResponse = z.object({
  ok: z.literal(true),
  favorite: z.boolean(),
});
export type ReadFavoriteResponse = z.infer<typeof ReadFavoriteResponse>;

export const ReadCheckRequest = z.object({
  checkId: z.string().min(1),
  selectedOptionId: z.string().min(1),
});
export type ReadCheckRequest = z.infer<typeof ReadCheckRequest>;

export const ReadCheckResponse = z.object({
  correct: z.boolean(),
  correctOptionId: z.string(),
  /** 答错时为 true（该 focus 项将在下一次 Today 获得一题额外正式复习） */
  needsReinforcementMarked: z.boolean(),
});
export type ReadCheckResponse = z.infer<typeof ReadCheckResponse>;
