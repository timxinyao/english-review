// 复习机制核心参数（FSRS 排期，PRODUCT_DESIGN 附录 A 2026-10 换轨）

/** mastered 谓词阈值：stability ≥ 120 天视为掌握（两维规则见 review/goals） */
export const MASTERED_STABILITY_DAYS = 120;

/** Production 首次激活：次日 */
export const PRODUCTION_FIRST_REVIEW_DELAY_DAYS = 1;

/** 单 Item 单 Session 补强上限 */
export const MAX_REINFORCEMENT_PER_ITEM_PER_SESSION = 2;
/** 补强插入位置：当前位置之后至少隔 3 题 */
export const REINFORCEMENT_MIN_GAP = 3;
/** 或队列后 30% 区域 */
export const REINFORCEMENT_TAIL_RATIO = 0.3;

/** 题库存量；cloze 只供旧题生命周期清理读取，不再预取或生成。 */
export const QUESTION_TARGET_STOCK = {
  understanding: 3,
  cloze: 3,
  production: 2,
} as const;

export const QUESTION_MAX_STOCK = {
  understanding: 8,
  cloze: 8,
  production: 6,
} as const;

/** Personal Example */
export const PERSONAL_EXAMPLE_MAX = 3;
/** 新句 quality_score > 最差 unpinned + 0.1 才替换 */
export const PERSONAL_EXAMPLE_REPLACE_MARGIN = 0.1;
/** 每项保留的近期造句历史 */
export const PRODUCTION_HISTORY_KEEP = 10;

/** 生命周期保留期（天） */
export const RETIRED_DELETE_DAYS = 45;
export const BAD_QUESTION_KEEP_DAYS = 30;
export const READ_KEEP_DAYS = 30;
export const ATTEMPT_DETAIL_KEEP_DAYS = 60;
export const REVIEW_TASKS_KEEP_DAYS = 365;

/** 每日新学习项额度 */
export const DEFAULT_MAX_NEW_ITEMS_PER_DAY = 10;
export const MAX_NEW_ITEMS_CHOICES = [5, 10, 15, 20] as const;
export const MAX_NEW_ITEMS_UNLIMITED = -1;
/** 今日复习上限：Session 创建时到期复习题入队上限（PRODUCT V2 规则，2026-10-27） */
export const DEFAULT_TODAY_REVIEW_LIMIT = 15;
export const TODAY_REVIEW_LIMIT_CHOICES = [10, 15, 20, 30] as const;
export const TODAY_REVIEW_LIMIT_UNLIMITED = -1;
/** 同日追加学习（extend）：不限制模式下每批追加数量 */
export const EXTEND_BATCH_UNLIMITED = 10;

/** 列表展示用的自然语言阶段（PRODUCT_DESIGN §6.1，按 FSRS stability 分档） */
export type ReviewStageLabel = '未开始' | '新' | '巩固' | '熟练' | '掌握';

export function stabilityStageLabel(stability: number | null): ReviewStageLabel {
  if (stability === null) return '未开始';
  if (stability < 7) return '新';
  if (stability < 30) return '巩固';
  if (stability < MASTERED_STABILITY_DAYS) return '熟练';
  return '掌握';
}
