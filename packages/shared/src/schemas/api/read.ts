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

/**
 * 检查题视图（V1 遗留，只读）：V2 起不再生成/作答检查题。
 * 未答检查题（answered=null）不泄露正确答案，也没有提交入口；
 * 已答检查题回放首答结果与当时已揭晓的正确选项。
 */
export const ReadCheckAnsweredView = z.object({
  selectedOptionId: z.string(),
  correctOptionId: z.string(),
  correct: z.boolean(),
});
export type ReadCheckAnsweredView = z.infer<typeof ReadCheckAnsweredView>;

export const ReadCheckView = z.object({
  checkId: z.string(),
  learningItemId: z.string(),
  target: z.string(),
  question: z.string(),
  options: z.array(z.object({ id: z.string(), text: z.string() })).min(2),
  /** null = V1 遗留未答（V2 起不可再作答） */
  answered: ReadCheckAnsweredView.nullable(),
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
  /** V2 新文章为 []；V1 遗留文章保留存储的检查题（只读） */
  checks: z.array(ReadCheckView).max(2),
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

// ---------- 收藏 / 检查（V1 遗留：V2 cutover 后提交一律 409，路由仅为旧客户端保留） ----------

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
  /** V2 起恒为 false：Read 路径不再置补强旗；非 false 值仅出现在 V1 历史回放 */
  needsReinforcementMarked: z.boolean(),
});
export type ReadCheckResponse = z.infer<typeof ReadCheckResponse>;
