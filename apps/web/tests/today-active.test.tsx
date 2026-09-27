import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import {
  apiCalls,
  makeActive,
  makeChoiceTask,
  makeCompleted,
  makeLearnTask,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

describe('Today 任务卡：learn Recall 卡 / 稍后再做 / 坏题', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('稍后再做按钮已移除（右滑替代）', async () => {
    stubApi({
      '/api/today': makeActive(makeLearnTask(), { completed: 1, total: 4 }),
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: 'gravity' });
    expect(screen.queryByRole('button', { name: '稍后再做' })).not.toBeInTheDocument();
  });

  it('坏题：confirm 流程后 POST bad-question、撤销并刷新', async () => {
    // 状态序列：初始 task-1 → 答错后 refetch 到下一题 → 坏题撤销后完成
    const statusQueue = [
      makeActive(makeChoiceTask(), { completed: 1, total: 4 }),
      makeActive(
        makeChoiceTask({
          taskId: 'task-2',
          question: {
            questionId: 'q-2',
            kind: 'direct_meaning',
            context: null,
            question: '"make sense" 的意思是？',
            options: [
              { id: 'm1', text: '讲得通' },
              { id: 'm2', text: '毫无意义' },
            ],
          },
        }),
        { completed: 1, total: 4 },
      ),
    ];
    stubApi({
      '/api/today': () => statusQueue.shift() ?? makeCompleted({ totalTasks: 3 }),
      '/api/today/tasks/task-1/answer': makeWrongAnswer(),
      '/api/today/tasks/task-1/bad-question': { ok: true, progress: { completed: 1, total: 3 } },
    });
    renderTodayApp();

    // 答题前没有坏题入口
    expect(screen.queryByRole('button', { name: '坏题' })).not.toBeInTheDocument();

    // understanding Recall：显示答案 → 没想起来（fail 冻结反馈）
    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '没想起来' }));
    expect(
      await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === '没想起来'),
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '坏题' }));
    const dialog = screen.getByRole('dialog', { name: '标记坏题' });
    expect(dialog).toBeVisible();
    expect(screen.getByText('标记坏题将撤销本次作答影响')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/bad-question')).toHaveLength(1);
    });
    const badCalls = apiCalls('/api/today/tasks/task-1/bad-question');
    expect(badCalls[0].init).toMatchObject({ method: 'POST' });
    expect(await screen.findByRole('heading', { name: '今天完成了' })).toBeVisible();
    // 答案与坏题各 invalidate 一次：共 3 次状态请求
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(3);
  });
});
