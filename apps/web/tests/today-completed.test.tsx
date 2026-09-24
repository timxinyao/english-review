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

  it('recommendRead=true 时提示 Read 复现（Phase 5 开放）；false 时不提示', async () => {
    stubApi({ '/api/today': makeCompleted({ recommendRead: true }) });
    renderTodayApp();
    expect(await screen.findByText('可以生成一篇 Read 复现今日内容（Phase 5 开放）')).toBeVisible();

    cleanup();
    stubApi({ '/api/today': makeCompleted({ recommendRead: false }) });
    renderTodayApp();
    expect(await screen.findByRole('heading', { name: '今天完成了' })).toBeVisible();
    expect(
      screen.queryByText('可以生成一篇 Read 复现今日内容（Phase 5 开放）'),
    ).not.toBeInTheDocument();
  });
});
