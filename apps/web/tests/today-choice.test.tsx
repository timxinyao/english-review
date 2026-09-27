import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import {
  apiCalls,
  jsonBodyOf,
  makeActive,
  makeChoiceTask,
  makeCorrectAnswer,
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

/** 第 2 张卡：understanding 复习（用于断言"下一题"确实切换了任务） */
function secondTask() {
  return makeChoiceTask({
    taskId: 'task-2',
    item: { id: 'item-2', type: 'word', target: 'stable', meaning: '稳定的', ipa: '/ˈsteɪbl/', notes: null },
  });
}

/**
 * Learn 卡两阶段：点击展开释义。
 * 注意：fake timers 下 RTL findBy* 永不 settle，fake-timers 用例必须用同步 query
 * （与既有 fake-timers 用例手法一致）；real-timers 用例用下面的异步版本。
 */
function revealLearnQuestion() {
  fireEvent.click(screen.getByRole('button', { name: '点击显示释义' }));
}

/** 异步版本：等待 learn 卡挂载后再展开（real-timers 用例） */
async function revealLearnQuestionAfterMount() {
  fireEvent.click(await screen.findByRole('button', { name: '点击显示释义' }));
  await screen.findByRole('group', { name: '选项' });
}

function optionOrder(): (string | null)[] {
  return Array.from(screen.getByRole('group', { name: '选项' }).querySelectorAll('button')).map(
    (btn) => btn.textContent,
  );
}

describe('Today 选择题任务卡（learn 首题）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi({
      '/api/today': makeActive(makeLearnTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-learn/answer': makeWrongAnswer(),
    });
  });

  it('active 态渲染进度 x / y；点击展开释义后可作答', async () => {
    renderTodayApp();

    expect(await screen.findByText('1 / 4')).toBeVisible();
    // 阶段 1：释义模糊（覆盖层），先展开释义
    expect(screen.getByRole('button', { name: '点击显示释义' })).toBeVisible();
    revealLearnQuestion();
    expect(screen.getByRole('button', { name: '重力' })).toBeVisible();
    expect(screen.getByRole('button', { name: '引力波' })).toBeVisible();
    expect(screen.getByRole('button', { name: '严重性' })).toBeVisible();
  });

  it('选项 shuffle：集合完整、顺序确定且重新挂载后稳定；提交的是真实 option id', async () => {
    const first = renderTodayApp();
    await revealLearnQuestionAfterMount();
    const firstOrder = optionOrder();
    first.unmount();

    renderTodayApp();
    await revealLearnQuestionAfterMount();
    const secondOrder = optionOrder();

    // 集合一致（不丢选项）且顺序稳定（同一 questionId 会话内稳定）
    expect(new Set(firstOrder)).toEqual(new Set(['重力', '引力波', '严重性']));
    expect(firstOrder).toEqual(secondOrder);

    // 点击显示出来的“引力波”，提交的必须是该项真实 id o2
    fireEvent.click(screen.getByRole('button', { name: '引力波' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-learn/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-learn/answer')[0])).toEqual({
      selectedOptionId: 'o2',
    });
  });

  it('答对：不自动跳题，点"下一题"按钮推进（与答错统一）', async () => {
    vi.useFakeTimers();
    try {
      const statusQueue = [makeActive(makeLearnTask())];
      stubApi({
        '/api/today': () =>
          statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
        '/api/today/tasks/task-learn/answer': makeCorrectAnswer(),
      });
      renderTodayApp();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      revealLearnQuestion();
      fireEvent.click(screen.getByRole('button', { name: '重力' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('回答正确')).toBeVisible();

      // 越过原 4s 自动跳题窗口：仍停留本题反馈（下一张卡未出现）
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByText('回答正确')).toBeVisible();
      expect(screen.queryByText('"stable" 的意思是？')).toBeNull();

      // 统一手动"下一题"按钮推进
      fireEvent.click(screen.getByRole('button', { name: '下一题' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
      expect(screen.getByRole('heading', { name: 'stable' })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('答对后点"下一题"按钮立即继续', async () => {
    vi.useFakeTimers();
    try {
      const statusQueue = [makeActive(makeLearnTask())];
      stubApi({
        '/api/today': () =>
          statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
        '/api/today/tasks/task-learn/answer': makeCorrectAnswer(),
      });
      renderTodayApp();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      revealLearnQuestion();
      fireEvent.click(screen.getByRole('button', { name: '重力' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // 时间停在 0ms，仅靠"下一题"按钮推进
      fireEvent.click(screen.getByRole('button', { name: '下一题' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
      expect(screen.getByRole('heading', { name: 'stable' })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('答错：显示正确答案与解释；手动下一题；不显示“太简单了”', async () => {
    const statusQueue = [makeActive(makeLearnTask())];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-learn/answer': makeWrongAnswer({
        explanation: 'gravity 在物理语境指重力。',
      }),
    });
    renderTodayApp();

    await revealLearnQuestionAfterMount();
    fireEvent.click(screen.getByRole('button', { name: '引力波' }));

    expect(await screen.findByText('回答错误')).toBeVisible();
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '正确答案：重力'),
    ).toBeVisible();
    expect(screen.getByText('gravity 在物理语境指重力。')).toBeVisible();
    // 反馈小按钮：答错后 too_easy 无意义应隐藏，蒙的保留
    expect(screen.queryByText('太简单了')).not.toBeInTheDocument();
    expect(screen.queryByText('其实是蒙的')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByRole('heading', { name: 'stable' })).toBeVisible();
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
  });

  it('反馈按钮：点击后 POST feedback 并立即继续下一题', async () => {
    const statusQueue = [makeActive(makeLearnTask())];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
      '/api/today/tasks/task-learn/answer': makeCorrectAnswer(),
      '/api/today/tasks/task-learn/feedback': { ok: true, adjustedResult: 'pass' },
    });
    renderTodayApp();

    await revealLearnQuestionAfterMount();
    fireEvent.click(screen.getByRole('button', { name: '重力' }));
    expect(await screen.findByText('回答正确')).toBeVisible();

    fireEvent.click(screen.getByText('太简单了'));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-learn/feedback')).toHaveLength(1);
    });
    const feedbackCalls = apiCalls('/api/today/tasks/task-learn/feedback');
    expect(jsonBodyOf(feedbackCalls[0])).toEqual({ feedback: 'too_easy' });
    expect(await screen.findByRole('heading', { name: 'stable' })).toBeVisible();
    // 答案与 feedback 各 invalidate 一次：共 3 次状态请求
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(3);
  });
});
