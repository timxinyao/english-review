import type { HeatmapCell } from '@el/shared';

/**
 * 12 个月热力图布局（PRODUCT §5.4）：
 * 每格 = 当天完成的正式 Today 任务数；不显示连续学习天数。
 */

/** 一周 7 行（一 → 日） */
export type HeatmapWeek = (HeatmapCell | null)[];

export interface HeatmapLayout {
  /** 列 = 周（52~53 列），行 = 周内天（周一第一行）；首列起始日前留 null */
  weeks: HeatmapWeek[];
  /** 与 weeks 等长；月份变化处为「M月」，否则 null */
  monthLabels: (string | null)[];
}

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' → UTC 零点（避免本地时区偏移） */
export function parseHeatmapDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** 周内序号：周一 = 0 … 周日 = 6 */
export function heatmapWeekday(date: string): number {
  return (parseHeatmapDate(date).getUTCDay() + 6) % 7;
}

/** 旧 → 新的 365 天数据 → GitHub 风格周列布局 */
export function buildHeatmapLayout(heatmap: HeatmapCell[]): HeatmapLayout {
  if (heatmap.length === 0) return { weeks: [], monthLabels: [] };

  const weeks: HeatmapWeek[] = [];
  let week: HeatmapWeek =
    heatmapWeekday(heatmap[0].date) === 0
      ? []
      : new Array(heatmapWeekday(heatmap[0].date)).fill(null);

  for (const cell of heatmap) {
    week.push(cell);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }

  // 每列以首日（第一个非空格）所在月份标注；月份相对上一列变化时显示
  const monthLabels: (string | null)[] = [];
  let prevMonth: number | null = null;
  for (const w of weeks) {
    const first = w.find(Boolean);
    const month: number | null = first ? parseHeatmapDate(first.date).getUTCMonth() : prevMonth;
    monthLabels.push(month !== null && month !== prevMonth ? `${month + 1}月` : null);
    if (month !== null) prevMonth = month;
  }
  return { weeks, monthLabels };
}

/** 色阶（只允许 token 工具类；禁止 hex/内联样式） */
export function heatmapCellClass(count: number): string {
  if (count <= 0) return 'bg-muted';
  if (count < 10) return 'bg-accent-soft';
  if (count < 20) return 'bg-accent text-accent-foreground';
  return 'bg-accent text-accent-foreground opacity-80';
}

export function heatmapCellTitle(cell: HeatmapCell): string {
  return `${cell.date} · ${cell.count} 个任务`;
}

/** 连续日期工具（供测试与文档化；运行时数据来自 GET /api/stats） */
export function consecutiveDates(endDate: string, n: number): string[] {
  const end = parseHeatmapDate(endDate).getTime();
  const dates: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    dates.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
  }
  return dates;
}
