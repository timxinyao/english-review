import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { StatsResponse } from '@el/shared';
import { api } from '../src/lib/api';
import { StatsPage } from '../src/features/stats/StatsPage';
import { makeHeatmap } from './stats-heatmap.test';

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

afterEach(cleanup);

const statsApi = vi.mocked(api);

function makeStats(overrides: Partial<StatsResponse> = {}): StatsResponse {
  return {
    totals: {
      items: 6,
      words: 3,
      chunks: 3,
      active: 2,
      mastered: 1,
      paused: 0,
      archived: 1,
      newQueue: 1,
    },
    last7DaysFormalTasks: 14,
    productionAttempts: 0,
    productionPass: 0,
    productionPassRate: null,
    last30DaysNewItems: 3,
    heatmap: makeHeatmap('2026-09-25'),
    ...overrides,
  };
}

function renderStatsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<StatsPage />, { wrapper });
}

/** dl 行：按 dt 文本取同行 dd 的主值（dd 首子节点，不含注脚小字） */
function overviewValue(label: string): string {
  const row = screen.getByText(label).closest('div') as HTMLElement;
  const dd = within(row).getByRole('definition');
  return ((dd.firstChild as HTMLElement | Text).textContent ?? '').trim();
}

describe('Stats 页', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statsApi.mockImplementation(((path: string) => {
      if (path === '/api/stats') return Promise.resolve(makeStats());
      return Promise.reject(new Error(`unexpected path: ${path}`));
    }) as typeof api);
  });

  it('总览以 dl 行式渲染核心数字与归档注脚', async () => {
    renderStatsPage();
    expect(await screen.findByText('总学习项')).toBeVisible();
    expect(overviewValue('总学习项')).toBe('6');
    expect(screen.getByText(/含已归档 1 项/)).toBeVisible();
    expect(overviewValue('Word / Chunk')).toBe('3 / 3');
    expect(overviewValue('学习中')).toBe('2');
    expect(overviewValue('已掌握')).toBe('1');
    expect(overviewValue('已暂停')).toBe('0');
    expect(overviewValue('已归档')).toBe('1');
    expect(overviewValue('New Queue 待学')).toBe('1');
    expect(overviewValue('最近 7 天正式任务')).toBe('14');
    expect(overviewValue('最近 30 天新增')).toBe('3');
  });

  it('通过率无作答时显示“暂无”', async () => {
    renderStatsPage();
    expect(await screen.findByText('总学习项')).toBeVisible();
    expect(overviewValue('表达题通过率')).toBe('暂无');
  });

  it('通过率数值取整为百分比', async () => {
    statsApi.mockImplementation(((path: string) => {
      if (path === '/api/stats')
        return Promise.resolve(
          makeStats({ productionPassRate: 0.6667, productionAttempts: 6, productionPass: 4 }),
        );
      return Promise.reject(new Error(`unexpected path: ${path}`));
    }) as typeof api);
    renderStatsPage();
    expect(await screen.findByText('总学习项')).toBeVisible();
    expect(overviewValue('表达题通过率')).toBe('67%');
  });

  it('热力图渲染 365 格，title 为「日期 · n 个任务」', async () => {
    renderStatsPage();
    await screen.findByText('总学习项');
    const cells = await screen.findAllByTitle(/ 个任务$/);
    expect(cells).toHaveLength(365);
    expect(screen.getByTitle('2026-09-25 · 0 个任务')).toBeInTheDocument();
  });

  it('色阶四档各得正确 token class（0 / 5 / 15 / 25）', async () => {
    statsApi.mockImplementation(((path: string) => {
      if (path === '/api/stats')
        return Promise.resolve(
          makeStats({ heatmap: makeHeatmap('2026-09-25', 365, { 10: 5, 20: 15, 30: 25 }) }),
        );
      return Promise.reject(new Error(`unexpected path: ${path}`));
    }) as typeof api);
    renderStatsPage();
    await screen.findByText('总学习项');

    // fixture 索引 0 = 2025-09-26（365 天前），索引 n = +n 天
    const cell5 = screen.getByTitle('2025-10-06 · 5 个任务');
    expect(cell5.className).toContain('bg-accent-soft');
    const cell15 = screen.getByTitle('2025-10-16 · 15 个任务');
    expect(cell15.className).toContain('bg-accent');
    expect(cell15.className).not.toContain('bg-accent-soft');
    const cell25 = screen.getByTitle('2025-10-26 · 25 个任务');
    expect(cell25.className).toContain('opacity-80');
    const cell0 = screen.getByTitle('2026-09-25 · 0 个任务');
    expect(cell0.className).toContain('bg-muted');
  });

  it('月份标签与图例（少/多）可见', async () => {
    renderStatsPage();
    await screen.findByText('总学习项');
    expect(screen.getByText('1月')).toBeVisible();
    expect(screen.getByText('少')).toBeVisible();
    expect(screen.getByText('多')).toBeVisible();
  });

  it('全 0 时热力图全灰并显示安静说明', async () => {
    statsApi.mockImplementation(((path: string) => {
      if (path === '/api/stats')
        return Promise.resolve(
          makeStats({
            totals: {
              items: 1,
              words: 1,
              chunks: 0,
              active: 1,
              mastered: 0,
              paused: 0,
              archived: 0,
              newQueue: 1,
            },
          }),
        );
      return Promise.reject(new Error(`unexpected path: ${path}`));
    }) as typeof api);
    renderStatsPage();
    await screen.findByText('总学习项');
    const cells = screen.getAllByTitle(/ 个任务$/);
    expect(cells).toHaveLength(365);
    for (const c of cells) expect(c.className).toContain('bg-muted');
    expect(screen.getByText(/还没有正式复习记录/)).toBeVisible();
  });

  it('加载失败显示安静错误提示', async () => {
    statsApi.mockImplementation((() => Promise.reject(new Error('boom'))) as typeof api);
    renderStatsPage();
    expect(await screen.findByText(/读取失败/)).toBeVisible();
  });
});
