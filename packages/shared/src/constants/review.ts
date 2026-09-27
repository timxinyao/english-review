// 复习机制核心参数（PRODUCT_DESIGN 附录 A + Phase 3 确认的默认值）

export const REVIEW_LEVELS = [1, 2, 3, 4, 5, 6, 7] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

/** 每个级别的成功后续间隔（天）；level N -> INTERVALS_DAYS[N-1] */
export const INTERVALS_DAYS = [1, 3, 7, 14, 30, 60, 120] as const;

export const LEVEL_MIN = 1;
export const LEVEL_MAX = 7;
/** 未激活 */
export const LEVEL_INACTIVE = 0;

/** basic_pass：当前级别间隔 × 0.5（最少 1 天） */
export const BASIC_PASS_INTERVAL_FACTOR = 0.5;
/** fail：降级后间隔 × 0.5（最少 1 天） */
export const FAIL_INTERVAL_FACTOR = 0.5;
export const MIN_INTERVAL_DAYS = 1;
/** too_easy：pass 基础上最多额外 +1 级 */
export const TOO_EASY_EXTRA_LEVELS = 1;

/** Production 首次激活：次日 */
export const PRODUCTION_FIRST_REVIEW_DELAY_DAYS = 1;

/** 单 Item 单 Session 补强上限 */
export const MAX_REINFORCEMENT_PER_ITEM_PER_SESSION = 2;
/** 补强插入位置：当前位置之后至少隔 3 题 */
export const REINFORCEMENT_MIN_GAP = 3;
/** 或队列后 30% 区域 */
export const REINFORCEMENT_TAIL_RATIO = 0.3;

/** 题库存量 */
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
/** 同日追加学习（extend）：不限制模式下每批追加数量 */
export const EXTEND_BATCH_UNLIMITED = 10;

/** 题型按 Production 阶段的映射（PRODUCT_DESIGN 6.3） */
export const PRODUCTION_STAGE_QUESTION_MIX = {
  early: 'cloze', // P-L1 ~ P-L2 填空为主
  middle: 'mixed', // P-L3 填空 + 表达混合
  late: 'production', // P-L4 ~ P-L7 表达为主
} as const;

export function productionStageOf(level: number): keyof typeof PRODUCTION_STAGE_QUESTION_MIX {
  if (level <= 2) return 'early';
  if (level === 3) return 'middle';
  return 'late';
}

/** 列表展示用的自然语言阶段（PRODUCT_DESIGN §6.1） */
export type ReviewStageLabel = '未开始' | '初学' | '练习中' | '稳定';

export function reviewStageLabel(level: number, stable: boolean): ReviewStageLabel {
  if (stable || level >= 7) return '稳定';
  if (level >= 3) return '练习中';
  if (level >= 1) return '初学';
  return '未开始';
}
