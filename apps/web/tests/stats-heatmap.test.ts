import { describe, expect, it } from 'vitest';
import type { HeatmapCell } from '@el/shared';
import {
  buildHeatmapLayout,
  heatmapCellClass,
  heatmapCellTitle,
  parseHeatmapDate,
} from '../src/features/stats/heatmap';

/** 从 endDate（含）往回数 n 天，生成旧 → 新的 365 天 fixture（count 默认 0） */
export function makeHeatmap(
  endDate: string,
  n = 365,
  counts: Record<number, number> = {},
): HeatmapCell[] {
  const end = new Date(`${endDate}T00:00:00Z`);
  const cells: HeatmapCell[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000);
    cells.push({ date: d.toISOString().slice(0, 10), count: 0 });
  }
  for (const [idx, count] of Object.entries(counts)) cells[Number(idx)].count = count;
  return cells;
}

describe('parseHeatmapDate', () => {
  it('按 UTC 解析 YYYY-MM-DD（不受本地时区影响）', () => {
    const d = parseHeatmapDate('2026-09-25');
    expect(d.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(d.getUTCDay()).toBe(5); // 周五
  });
});

describe('buildHeatmapLayout（GitHub 风格布局）', () => {
  it('首列按起始日星期偏移留空，总格数等于输入天数', () => {
    // 2026-09-25 是周五；365 天前是 2025-09-26（周五）→ 偏移 4（周一=0）
    const layout = buildHeatmapLayout(makeHeatmap('2026-09-25'));
    const total = layout.weeks.reduce((sum, w) => sum + w.filter(Boolean).length, 0);
    expect(total).toBe(365);
    expect(layout.weeks[0].slice(0, 4)).toEqual([null, null, null, null]);
    expect(layout.weeks[0][4]).not.toBeNull();
    // 列数 52~53（一年）
    expect(layout.weeks.length).toBeGreaterThanOrEqual(52);
    expect(layout.weeks.length).toBeLessThanOrEqual(53);
  });

  it('每列 7 行、按周内顺序（一 → 日）排列', () => {
    const layout = buildHeatmapLayout(makeHeatmap('2026-09-25'));
    for (const week of layout.weeks) expect(week).toHaveLength(7);
    // 首列最后一个非空格是起始日（周五=行 4）
    expect(layout.weeks[0][4]!.date).toBe('2025-09-26');
  });

  it('月份标签在月份变化处标注，格式为 M 月', () => {
    const layout = buildHeatmapLayout(makeHeatmap('2026-09-25'));
    const labels = layout.monthLabels.filter(Boolean) as string[];
    // 12 个月窗口跨约 13 个自然月边界；至少 12 次标注且含 1 月
    expect(labels.length).toBeGreaterThanOrEqual(12);
    expect(labels).toContain('1月');
    // 标注列的首日月份与标签一致（抽第一列）
    const firstIdx = layout.monthLabels.findIndex(Boolean);
    const firstDay = layout.weeks[firstIdx].find(Boolean) as HeatmapCell;
    expect(layout.monthLabels[firstIdx]).toBe(
      `${parseHeatmapDate(firstDay.date).getUTCMonth() + 1}月`,
    );
  });

  it('空数组返回空布局', () => {
    const layout = buildHeatmapLayout([]);
    expect(layout.weeks).toEqual([]);
    expect(layout.monthLabels).toEqual([]);
  });
});

describe('heatmapCellClass（色阶只用 tokens）', () => {
  it.each([
    [0, 'bg-muted'],
    [1, 'bg-accent-soft'],
    [9, 'bg-accent-soft'],
    [10, 'bg-accent'],
    [19, 'bg-accent'],
    [20, 'opacity-80'],
    [99, 'opacity-80'],
  ])('count=%i → 含 %s', (count, expected) => {
    expect(heatmapCellClass(count)).toContain(expected);
  });

  it('四档互不相同', () => {
    const tiers = [
      heatmapCellClass(0),
      heatmapCellClass(5),
      heatmapCellClass(15),
      heatmapCellClass(25),
    ];
    expect(new Set(tiers).size).toBe(4);
  });
});

describe('heatmapCellTitle', () => {
  it('格式为 YYYY-MM-DD · n 个任务', () => {
    expect(heatmapCellTitle({ date: '2026-09-25', count: 7 })).toBe('2026-09-25 · 7 个任务');
    expect(heatmapCellTitle({ date: '2026-09-25', count: 0 })).toBe('2026-09-25 · 0 个任务');
  });
});
