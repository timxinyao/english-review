import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

describe('Today 任务卡：learn 卡 / 稍后再做 / 坏题', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('learn 卡渲染 target/ipa/meaning/原句与最多 1 条补充例句 + 发音按钮', async () => {
    stubApi({
      '/api/today': makeActive(
        makeLearnTask({
          supplementaryExamples: ['Gravity is a fundamental force.', 'Gravity keeps us grounded.'],
        }),
      ),
    });
    renderTodayApp();

    expect(await screen.findByRole('heading', { name: 'gravity' })).toBeVisible();
    expect(screen.getByText('/ˈɡrævəti/')).toBeVisible();
    // 阶段 1：释义模糊（点击展开前不可见为 <p>）
    expect(screen.getByRole('button', { name: '点击显示释义' })).toBeVisible();
    expect(screen.getByText('I laugh at gravity all the time.')).toBeVisible();
    expect(screen.getByText('Gravity is a fundamental force.')).toBeVisible();
    expect(screen.queryByText('Gravity keeps us grounded.')).not.toBeInTheDocument();
    expect(screen.getByText('补充例句')).toBeVisible();
    expect(screen.getByRole('button', { name: '朗读 gravity' })).toBeVisible();
    // 阶段 1：题目未出现
    expect(screen.queryByText('”gravity” 的意思是？')).not.toBeInTheDocument();

    // 阶段 2：点击展开释义 → 释义可见 + 题目出现
    fireEvent.click(screen.getByRole('button', { name: '点击显示释义' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '重力' })).toBeVisible();
    });
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '重力'),
    ).toBeVisible();
  });

  it('稍后再做：POST later 并 invalidate/refetch today', async () => {
    const nextCard = makeChoiceTask({
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
    });
    const statusQueue = [makeActive(makeChoiceTask(), { completed: 0, total: 4 })];
    stubApi({
      '/api/today': () => statusQueue.shift() ?? makeActive(nextCard, { completed: 0, total: 4 }),
      '/api/today/tasks/task-1/later': { ok: true, progress: { completed: 0, total: 4 } },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '稍后再做' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/later')).toHaveLength(1);
    });
    const laterCalls = apiCalls('/api/today/tasks/task-1/later');
    expect(laterCalls[0].init).toMatchObject({ method: 'POST' });
    expect(await screen.findByText('"make sense" 的意思是？')).toBeVisible();
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
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

    fireEvent.click(await screen.findByRole('button', { name: '摇晃的' }));
    expect(await screen.findByText('回答错误')).toBeVisible();

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
