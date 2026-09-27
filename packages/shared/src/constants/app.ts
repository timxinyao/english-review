// 应用级常量

export const DEFAULT_APP_TIMEZONE = 'Asia/Shanghai';
export const SESSION_COOKIE_NAME = 'el_session';
export const SESSION_TTL_DAYS = 30;

export const CONTENT_LEVELS = ['A2', 'B1', 'B2', 'C1'] as const;
export const DEFAULT_CONTENT_LEVEL = 'B1';

/** API 路径前缀 */
export const API_PREFIX = '/api';

/** 造句历史：个人例句展示条数等 */
export const EXTRA_EXAMPLES_SUGGESTED_MAX = 3;
export const RECENT_READS_ON_HOME = 3;
export const READ_BODY_MIN_WORDS = 180;
export const READ_BODY_MAX_WORDS = 400;
export const READ_FOCUS_MIN = 3;
/** 实测瓶颈在提示词结构而非词数（2026-09-27 提示词重写后 5 词稳定）；不变式仍硬校验 coverage 完整 */
export const READ_FOCUS_MAX = 5;
export const READ_OLD_MIN = 3;
export const READ_OLD_MAX = 5;

/** 时区内的本地日期 YYYY-MM-DD（session_date / daily_stats 归属用；无第三方依赖） */
export function localDateString(date: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date);
}
