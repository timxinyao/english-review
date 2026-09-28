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
 * learn 首题走 Recall Card：hint 路径展开选择题。
 * 注意：fake timers 下 RTL findBy* 永不 settle，fake-timers 用例必须用同步 query
 * （与既有 fake-timers 用例手法一致）；real-timers 用例用下面的异步版本。
 */
function openHintOptions() {
  fireEvent.click(screen.getByRole('button', { name: '给我提示' }));
}

/** 异步版本：等待 learn 卡挂载后再开 hint（real-timers 用例） */
async function openHintOptionsAfterMount() {
  fireEvent.click(await screen.findByRole('button', { name: '给我提示' }));
  await screen.findByRole('group', { name: '选项' });
}

function optionOrder(): (string | null)[] {
  return Array.from(screen.getByRole('group', { name: '选项' }).querySelectorAll('button')).map(
    (btn) => btn.textContent,
  );
}

describe('Today learn 首题（Recall Card：recall 直判 + hint 选择题）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi({
      '/api/today': makeActive(makeLearnTask(), { completed: 1, total: 4 }),
      '/api/today/tasks/task-learn/answer': makeWrongAnswer(),
    });
  });

  it('active 态渲染进度 x / y；learn 分派 RecallCard——hint 后可作答选择题', async () => {
    renderTodayApp();

    expect(await screen.findByText('1 / 4')).toBeVisible();
    // learn 不再直接渲染选择题：不剧透 meaning，也无选项
    expect(screen.queryByText('重力')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '选项' })).not.toBeInTheDocument();
    // hint 路径：给我提示 → 选择题出现
    openHintOptions();
    expect(screen.getByRole('button', { name: '重力' })).toBeVisible();
    expect(screen.getByRole('button', { name: '引力波' })).toBeVisible();
    expect(screen.getByRole('button', { name: '严重性' })).toBeVisible();
  });

  it('选项 shuffle：集合完整、顺序确定且重新挂载后稳定；提交的是真实 option id', async () => {
    const first = renderTodayApp();
    await openHintOptionsAfterMount();
    const firstOrder = optionOrder();
    first.unmount();

    renderTodayApp();
    await openHintOptionsAfterMount();
    const secondOrder = optionOrder();

    // 集合一致（不丢选项）且顺序稳定（同一 questionId 会话内稳定）
    expect(new Set(firstOrder)).toEqual(new Set(['重力', '引力波', '严重性']));
    expect(firstOrder).toEqual(secondOrder);

    // 点击显示出来的“引力波”，提交的必须是该项真实 id o2（hint 语义）
    fireEvent.click(screen.getByRole('button', { name: '引力波' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-learn/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-learn/answer')[0])).toEqual({
      selectedOptionId: 'o2',
      hintUsed: true,
    });
  });

  it('答对：refetch 成功后自动推进（评分即前进，无需点下一题）', async () => {
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

      fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
      fireEvent.click(screen.getByRole('button', { name: '想起来了' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByRole('heading', { name: 'stable' })).toBeVisible();
      expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
