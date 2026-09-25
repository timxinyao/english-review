import { localDateString, type StatsResponse } from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import { dailyStats, learningItems } from '../../db/schema.js';

/** 热力图窗口：以今天结尾的 365 天（PRODUCT §5.4 12 个月） */
export const HEATMAP_DAYS = 365;
/** 最近 7 天正式任务窗口（含今天） */
export const LAST7_DAYS = 7;
/** 最近 30 天新增窗口 */
export const NEW_ITEMS_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** 纯日期字符串平移 n 天（YYYY-MM-DD，UTC 锚点计算，与时区无关） */
export function shiftDateString(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/stats（PRODUCT §5.4）：
 * - totals 全量口径（items/words/chunks 含 archived；newQueue=active 且 queue_state=new）
 * - 最近 7 天（含今天，APP_TIMEZONE）正式任务数、表达通过率（全历史）、近 30 天新增
 * - 365 天热力图（旧 → 新，零填充）
 */
export function getStats(db: AppDatabase, timezone: string, now: Date): StatsResponse {
  const items = db
    .select({
      type: learningItems.type,
      status: learningItems.status,
      queueState: learningItems.queueState,
      createdAt: learningItems.createdAt,
    })
    .from(learningItems)
    .all();

  const totals = {
    items: items.length,
    words: items.filter((i) => i.type === 'word').length,
    chunks: items.filter((i) => i.type === 'chunk').length,
    active: items.filter((i) => i.status === 'active').length,
    mastered: items.filter((i) => i.status === 'mastered').length,
    paused: items.filter((i) => i.status === 'paused').length,
    archived: items.filter((i) => i.status === 'archived').length,
    newQueue: items.filter((i) => i.status === 'active' && i.queueState === 'new').length,
  };

  const statRows = db.select().from(dailyStats).all();

  const today = localDateString(now, timezone);
  const last7 = new Set(Array.from({ length: LAST7_DAYS }, (_, i) => shiftDateString(today, -i)));
  const last7DaysFormalTasks = statRows
    .filter((r) => last7.has(r.date))
    .reduce((sum, r) => sum + r.formalTasksCompleted, 0);

  const productionAttempts = statRows.reduce((sum, r) => sum + r.productionAttempts, 0);
  const productionPass = statRows.reduce((sum, r) => sum + r.productionPass, 0);
  const productionPassRate = productionAttempts > 0 ? productionPass / productionAttempts : null;

  const cutoff = new Date(now.getTime() - NEW_ITEMS_WINDOW_DAYS * DAY_MS).toISOString();
  const last30DaysNewItems = items.filter((i) => i.createdAt >= cutoff).length;

  const byDate = new Map(statRows.map((r) => [r.date, r.formalTasksCompleted]));
  const heatmap = Array.from({ length: HEATMAP_DAYS }, (_, i) => {
    const date = shiftDateString(today, -(HEATMAP_DAYS - 1 - i));
    return { date, count: byDate.get(date) ?? 0 };
  });

  return {
    totals,
    last7DaysFormalTasks,
    productionAttempts,
    productionPass,
    productionPassRate,
    last30DaysNewItems,
    heatmap,
  };
}
