import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import { makeActive, makeChoiceTask, makeIdle, renderTodayApp, stubApi } from './today-helpers';

afterEach(cleanup);

// mock fetch 封装（lib/api），保留 today hooks 的真实 invalidate/refetch 行为
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

describe('TodayPage idle 态', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi({ '/api/today': makeIdle() });
  });

  it('主卡片渲染 due/new 数字、开始按钮与 Recently learned 列表', async () => {
    renderTodayApp();

    expect(await screen.findByText('4 items due · 1 new today')).toBeVisible();
    expect(screen.getByRole('button', { name: '开始今日复习' })).toBeVisible();
    expect(screen.getByText('Recently learned')).toBeVisible();
    expect(screen.getByText('wear down')).toBeVisible();
    expect(screen.getByText('raw')).toBeVisible();
  });

  it('Recently learned 最多展示 5 条', async () => {
    stubApi({
      '/api/today': makeIdle({
        recentlyLearned: Array.from({ length: 6 }, (_, i) => ({
          id: `r${i}`,
          target: `item-${i}`,
          type: 'word' as const,
        })),
      }),
    });
    renderTodayApp();

    expect(await screen.findByText('item-4')).toBeVisible();
    expect(screen.queryByText('item-5')).not.toBeInTheDocument();
  });

  it('点击开始今日复习 POST /api/today/start 并 invalidate/refetch today', async () => {
    const active = makeActive(makeChoiceTask(), { completed: 0, total: 5 });
    const statusQueue = [makeIdle()];
    stubApi({
      '/api/today': () => statusQueue.shift() ?? active,
      '/api/today/start': active,
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '开始今日复习' }));

    await waitFor(() => {
      expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
    });
    expect(apiMock.mock.calls.find(([p]) => p === '/api/today/start')?.[1]).toMatchObject({
      method: 'POST',
    });
    // refetch 后进入 active 态渲染任务卡
    expect(await screen.findByText('"stable" 的意思是？')).toBeVisible();
  });
});
