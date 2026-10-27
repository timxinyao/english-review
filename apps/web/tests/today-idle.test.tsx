import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import { makeActive, makeChoiceTask, makeIdle, renderTodayApp, stubApi } from './today-helpers';

afterEach(cleanup);

// mock fetch 封装（lib/api），保留 today hooks 的真实 invalidate/refetch 行为
// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

describe('TodayPage idle 态', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi({ '/api/today': makeIdle() });
  });

  it('主卡片渲染今日计划拆分文案（无积压不显示积压行）、开始按钮、轻提示与列表', async () => {
    renderTodayApp();

    expect(await screen.findByText('今日计划 5 题（复习 4 · 新学 1）')).toBeVisible();
    expect(screen.getByText('词库 57 · 待学 27')).toBeVisible();
    expect(screen.queryByText(/积压还剩/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始今日复习' })).toBeVisible();
    expect(screen.getByText('做一点也行，不必一次清完')).toBeVisible();
    expect(screen.getByText('Recently learned')).toBeVisible();
    expect(screen.getByText('wear down')).toBeVisible();
    expect(screen.getByText('raw')).toBeVisible();
  });

  it('有积压时拆分显示「今日计划 / 积压还剩」（软上限截断，2026-10-27）', async () => {
    stubApi({
      '/api/today': makeIdle({ dueItems: 27, plannedReviews: 15, backlogLeft: 12 }),
    });
    renderTodayApp();

    expect(await screen.findByText('今日计划 16 题（复习 15 · 新学 1）')).toBeVisible();
    expect(screen.getByText('积压还剩 12 题，之后每天自动安排')).toBeVisible();
  });

  it('无到期无新学：显示空态文案，仍可开始（空会话直接完成）', async () => {
    stubApi({
      '/api/today': makeIdle({
        dueItems: 0,
        plannedReviews: 0,
        backlogLeft: 0,
        newTodayAvailable: 0,
      }),
    });
    renderTodayApp();

    expect(await screen.findByText('今天没有到期的复习')).toBeVisible();
    expect(screen.getByRole('button', { name: '开始今日复习' })).toBeVisible();
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
    // refetch 后进入 active 态渲染任务卡（understanding → Recall Card 直判态）
    expect(await screen.findByRole('heading', { name: 'stable' })).toBeVisible();
    expect(screen.getByRole('button', { name: '显示答案' })).toBeVisible();
  });
});
