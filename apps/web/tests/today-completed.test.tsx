import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCompleted, renderTodayApp, stubApi } from './today-helpers';

afterEach(cleanup);

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

describe('Today 完成摘要', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染今日摘要计数与“今天完成了”', async () => {
    stubApi({
      '/api/today': makeCompleted({
        totalTasks: 6,
        pass: 3,
        basicPass: 1,
        fail: 1,
        newItemsStarted: 1,
      }),
    });
    renderTodayApp();

    expect(await screen.findByRole('heading', { name: '今天完成了' })).toBeVisible();
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === '共完成 6 个任务 · 新学 1 项',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === '通过 3 · 基础通过 1 · 未通过 1',
      ),
    ).toBeVisible();
  });

  it('recommendRead=true 时提供 /read 链接；false 时不显示', async () => {
    stubApi({ '/api/today': makeCompleted({ recommendRead: true }) });
    renderTodayApp();
    const link = await screen.findByRole('link', { name: '生成一篇 Read 复现今日内容' });
    expect(link).toBeVisible();
    expect(link).toHaveAttribute('href', '/read');

    cleanup();
    stubApi({ '/api/today': makeCompleted({ recommendRead: false }) });
    renderTodayApp();
    expect(await screen.findByRole('heading', { name: '今天完成了' })).toBeVisible();
    expect(
      screen.queryByRole('link', { name: '生成一篇 Read 复现今日内容' }),
    ).not.toBeInTheDocument();
  });
});
