import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import {
  apiCalls,
  jsonBodyOf,
  makeActive,
  makeChoiceTask,
  makeCorrectAnswer,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

/** 第 2 张卡（用于断言“下一题”确实切换了任务） */
function secondTask() {
  return makeChoiceTask({
    taskId: 'task-2',
    question: {
      questionId: 'q-2',
      kind: 'context_meaning',
      context: 'Make sure the ladder is stable before you climb it.',
      question: '句中 stable 的意思是？',
      options: [
        { id: 's1', text: '稳固的' },
        { id: 's2', text: '摇晃的' },
      ],
    },
  });
}

function optionOrder(): (string | null)[] {
  return Array.from(screen.getByRole('group', { name: '选项' }).querySelectorAll('button')).map(
    (btn) => btn.textContent,
  );
}

describe('Today 选择题任务卡', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi({
      '/api/today': makeActive(makeChoiceTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-1/answer': makeWrongAnswer(),
    });
  });

  it('active 态渲染进度 x / y 与题面、选项', async () => {
    renderTodayApp();

    expect(await screen.findByText('1 / 4')).toBeVisible();
    expect(screen.getByText('"stable" 的意思是？')).toBeVisible();
    expect(screen.getByRole('group', { name: '选项' })).toBeVisible();
    expect(screen.getByRole('button', { name: '稳定的' })).toBeVisible();
    expect(screen.getByRole('button', { name: '摇晃的' })).toBeVisible();
    expect(screen.getByRole('button', { name: '昂贵的' })).toBeVisible();
  });

  it('选项 shuffle：集合完整、顺序确定且重新挂载后稳定；提交的是真实 option id', async () => {
    const first = renderTodayApp();
    await screen.findByRole('group', { name: '选项' });
    const firstOrder = optionOrder();
    first.unmount();

    renderTodayApp();
    await screen.findByRole('group', { name: '选项' });
    const secondOrder = optionOrder();

    // 集合一致（不丢选项）且顺序稳定（同一 questionId 会话内稳定）
    expect(new Set(firstOrder)).toEqual(new Set(['稳定的', '摇晃的', '昂贵的']));
    expect(firstOrder).toEqual(secondOrder);

    // 点击显示出来的“摇晃的”，提交的必须是该项真实 id o2
    fireEvent.click(await screen.findByRole('button', { name: '摇晃的' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    const answerCalls = apiCalls('/api/today/tasks/task-1/answer');
    expect(jsonBodyOf(answerCalls[0])).toEqual({ selectedOptionId: 'o2' });
  });

  it('答对：轻量反馈后 2 秒自动下一题（fake timers）', async () => {
    vi.useFakeTimers();
    try {
      const statusQueue = [makeActive(makeChoiceTask())];
      stubApi({
        '/api/today': () =>
          statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
        '/api/today/tasks/task-1/answer': makeCorrectAnswer(),
      });
      renderTodayApp();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByRole('button', { name: '稳定的' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('回答正确')).toBeVisible();

      // 2 秒内不切换
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1999);
      });
      expect(screen.getByText('"stable" 的意思是？')).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
      expect(screen.getByText('句中 stable 的意思是？')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('答对后点击任意处立即继续（无需等待 2 秒）', async () => {
    vi.useFakeTimers();
    try {
      const statusQueue = [makeActive(makeChoiceTask())];
      stubApi({
        '/api/today': () =>
          statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
        '/api/today/tasks/task-1/answer': makeCorrectAnswer(),
      });
      renderTodayApp();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByRole('button', { name: '稳定的' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // 时间停在 0ms，仅靠点击推进
      fireEvent.click(screen.getByText('回答正确'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
      expect(screen.getByText('句中 stable 的意思是？')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('答错：显示正确答案、解释、自动揭示原句；手动下一题；不显示“太简单了”', async () => {
    const statusQueue = [makeActive(makeChoiceTask())];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-1/answer': makeWrongAnswer(),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '摇晃的' }));

    expect(await screen.findByText('回答错误')).toBeVisible();
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '正确答案：稳定的'),
    ).toBeVisible();
    expect(screen.getByText('stable 在这里指结构上的稳固。')).toBeVisible();
    // 答错自动揭示 source example
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
    // 反馈小按钮：答错后 too_easy 无意义应隐藏，蒙的保留
    expect(screen.queryByText('太简单了')).not.toBeInTheDocument();
    expect(screen.getByText('其实是蒙的')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByText('句中 stable 的意思是？')).toBeVisible();
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
  });

  it('查看原句：答题前揭示 source example 并随答案提交 viewedSource', async () => {
    renderTodayApp();

    // 答题前不显示原句
    expect(screen.queryByText('The ladder feels stable.')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '查看原句' }));
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '摇晃的' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({
      selectedOptionId: 'o2',
      viewedSource: true,
    });
  });

  it('反馈按钮：点击后 POST feedback 并立即继续下一题', async () => {
    const statusQueue = [makeActive(makeChoiceTask())];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
      '/api/today/tasks/task-1/answer': makeCorrectAnswer(),
      '/api/today/tasks/task-1/feedback': { ok: true, adjustedResult: 'pass' },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '稳定的' }));
    expect(await screen.findByText('回答正确')).toBeVisible();

    fireEvent.click(screen.getByText('太简单了'));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/feedback')).toHaveLength(1);
    });
    const feedbackCalls = apiCalls('/api/today/tasks/task-1/feedback');
    expect(jsonBodyOf(feedbackCalls[0])).toEqual({ feedback: 'too_easy' });
    expect(await screen.findByText('句中 stable 的意思是？')).toBeVisible();
    // 答案与 feedback 各 invalidate 一次：共 3 次状态请求
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(3);
  });
});
