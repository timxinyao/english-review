import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import {
  apiCalls,
  jsonBodyOf,
  makeActive,
  makeClozeTask,
  makeCompleted,
  makeCorrectAnswer,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

describe('Today 填空题任务卡', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi({
      '/api/today': makeActive(makeClozeTask(), { completed: 2, total: 5 }),
      '/api/today/tasks/task-cloze/answer': makeCorrectAnswer(),
    });
  });

  it('按空位切分句面、内嵌输入（autofocus）；提交 answerText', async () => {
    renderTodayApp();

    expect(await screen.findByText('The')).toBeVisible();
    expect(screen.getByText('data has not been processed yet.')).toBeVisible();
    const input = screen.getByLabelText('填空答案');
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled();

    fireEvent.change(input, { target: { value: 'raw' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-cloze/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-cloze/answer')[0])).toEqual({
      answerText: 'raw',
    });
  });

  it('答对：显示完整句子并手动下一题（无自动跳转）', async () => {
    vi.useFakeTimers();
    try {
      const statusQueue = [makeActive(makeClozeTask())];
      stubApi({
        '/api/today': () =>
          statusQueue.shift() ??
          makeActive(makeClozeTask({ taskId: 'task-next' }), { completed: 3, total: 5 }),
        '/api/today/tasks/task-cloze/answer': makeCorrectAnswer({
          completeSentence: 'The raw data has not been processed yet.',
        }),
      });
      renderTodayApp();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.change(screen.getByLabelText('填空答案'), { target: { value: 'raw' } });
      fireEvent.click(screen.getByRole('button', { name: '提交' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText('The raw data has not been processed yet.')).toBeVisible();
      expect(screen.getByText('回答正确')).toBeVisible();

      // 填空题答对不自动跳转：越过 2 秒仍在当前卡；状态请求停在作答 invalidate 后的 2 次
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText('The raw data has not been processed yet.')).toBeVisible();
      expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);

      fireEvent.click(screen.getByRole('button', { name: '下一题' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // 手动下一题进入已 refetch 到的下一张填空卡（无需新的状态请求）
      expect(screen.getByLabelText('填空答案')).toBeVisible();
      expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('答错：显示可接受答案、完整句子、解释并自动揭示原句（含最后一题：反馈先于完成页）', async () => {
    // 状态序列：初始填空卡 → 答错后 refetch 已完成 → 冻结反馈展示 → 手动下一题进完成页
    const statusQueue = [makeActive(makeClozeTask())];
    stubApi({
      '/api/today': () => statusQueue.shift() ?? makeCompleted({ totalTasks: 5 }),
      '/api/today/tasks/task-cloze/answer': makeWrongAnswer({
        acceptedAnswer: 'raw',
        completeSentence: 'The raw data has not been processed yet.',
        explanation: 'raw 修饰 data 表示未加工的。',
      }),
    });
    renderTodayApp();

    fireEvent.change(await screen.findByLabelText('填空答案'), { target: { value: 'cooked' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(await screen.findByText('回答错误')).toBeVisible();
    expect(screen.getByText('The raw data has not been processed yet.')).toBeVisible();
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '可接受答案：raw'),
    ).toBeVisible();
    expect(screen.getByText('raw 修饰 data 表示未加工的。')).toBeVisible();
    // 答错自动揭示 source example
    expect(screen.getByText('Raw sugar is less sweet.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByRole('heading', { name: '今天完成了' })).toBeVisible();
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
  });
});
