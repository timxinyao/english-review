import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiCalls,
  makeActive,
  makeChoiceTask,
  makeLearnTask,
  makeSessionEntry,
  makeTasksResponse,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

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

  it('坏题：答错留在当前卡，下一题后从「今日学习」记录标记，confirm 流程 POST bad-question', async () => {
    let answered = false;
    const nextTask = makeChoiceTask({
      taskId: 'task-2',
      item: {
        id: 'item-2',
        type: 'word',
        target: 'make sense',
        meaning: '讲得通',
        ipa: null,
        notes: null,
      },
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
    const first = makeChoiceTask();
    stubApi({
      '/api/today': () =>
        answered
          ? makeActive(nextTask, { completed: 1, total: 4 })
          : makeActive(first, { completed: 1, total: 4 }),
      '/api/today/tasks': () =>
        answered
          ? makeTasksResponse([
              makeSessionEntry(first, makeWrongAnswer()),
              makeSessionEntry(nextTask, null),
            ])
          : makeTasksResponse([makeSessionEntry(first, null), makeSessionEntry(nextTask, null)]),
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return makeWrongAnswer();
      },
      '/api/today/tasks/task-1/bad-question': { ok: true, progress: { completed: 1, total: 4 } },
    });
    renderTodayApp();

    // 答题前卡片上没有坏题入口（坏题只在「今日学习」的具体记录上，PRODUCT §4.2/§6.5）
    await screen.findByRole('heading', { name: 'stable' });
    expect(screen.queryByRole('button', { name: '坏题' })).not.toBeInTheDocument();

    // 显示答案 → 没想起来 → 留在当前卡看揭示 → 手动下一题进 make sense
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '没想起来' }));
    expect(await screen.findByRole('button', { name: '下一题' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(await screen.findByRole('heading', { name: 'make sense' })).toBeVisible();

    // 打开今日学习 → 展开 stable 分组 → 记录上标记坏题 → confirm POST task-1
    fireEvent.click(screen.getByRole('button', { name: '查看今日学习' }));
    const sheet = screen.getByRole('dialog', { name: '今日学习' });
    await waitFor(() => expect(sheet).toBeVisible());
    fireEvent.click(within(sheet).getByRole('button', { name: /stable/ }));
    expect(await within(sheet).findByRole('button', { name: '坏题' })).toBeVisible();
    fireEvent.click(within(sheet).getByRole('button', { name: '坏题' }));
    const dialog = screen.getByRole('dialog', { name: '标记坏题' });
    expect(screen.getByText('标记坏题将撤销本次作答影响')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/bad-question')).toHaveLength(1);
    });
    expect(apiCalls('/api/today/tasks/task-1/bad-question')[0].init).toMatchObject({
      method: 'POST',
    });
    // 标记坏题不改变当前题：关闭弹层仍在 make sense
    fireEvent.click(sheet);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '今日学习' })).toBeNull());
    expect(await screen.findByRole('heading', { name: 'make sense' })).toBeVisible();
  });
});
