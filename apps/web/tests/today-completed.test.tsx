import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiCalls,
  makeActive,
  makeCanceledEntry,
  makeChoiceTask,
  makeCompleted,
  makeSessionEntry,
  makeTasksResponse,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

// 撤销成功会挂载 ActiveSession（自动 speak）：mock 掉真实 tts（jsdom 无 AudioContext）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
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
        (_, el) => el?.tagName === 'P' && el.textContent === '通过 3 · 基础通过 1 · 未通过 1',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === '词库剩余 27 词待学 · 共 57 词',
      ),
    ).toBeVisible();
  });

  it('recommendRead=true 时提供 /read 链接；false 时不显示', async () => {
    stubApi({ '/api/today': makeCompleted({ recommendRead: true }) });
    renderTodayApp();
    const link = await screen.findByRole('link', { name: '生成一篇 Read 复现今日内容' });
    expect(link).toBeVisible();
    expect(link).toHaveAttribute('href', '/read');

    cleanup();
    stubApi({ '/api/today': makeCompleted({ recommendRead: false }) });
    renderTodayApp();
    expect(await screen.findByRole('heading', { name: '今天完成了' })).toBeVisible();
    expect(
      screen.queryByRole('link', { name: '生成一篇 Read 复现今日内容' }),
    ).not.toBeInTheDocument();
  });
});

describe('Today 完成页撤销入口（PRODUCT §5.1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const answeredTask = makeChoiceTask(); // stable / understanding / fail
  /** 撤销后的替换题：同 item 不同题面（排到队尾） */
  const replacement = makeChoiceTask({
    taskId: 'task-repl',
    question: {
      questionId: 'q-repl',
      kind: 'direct_meaning',
      context: null,
      question: '"stable" 更接近的意思是？',
      options: [
        { id: 'o1', text: '稳定的' },
        { id: 'o2', text: '摇晃的' },
      ],
    },
  });

  it('完成页保留撤销入口：确认层写明题目；确认撤销后回到活动会话', async () => {
    let undone = false;
    stubApi({
      '/api/today': () =>
        undone ? makeActive(replacement, { completed: 0, total: 1 }) : makeCompleted(),
      '/api/today/tasks': () =>
        undone
          ? makeTasksResponse([
              makeCanceledEntry(answeredTask),
              makeSessionEntry(replacement, null),
            ])
          : makeTasksResponse([makeSessionEntry(answeredTask, makeWrongAnswer())], 'task-1'),
      '/api/today/tasks/task-1/undo': () => {
        undone = true;
        return { ok: true, progress: { completed: 0, total: 1 } };
      },
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: '今天完成了' });

    const undoIcon = await screen.findByRole('button', { name: '撤销最近一次作答' });
    expect(undoIcon).toBeVisible();
    fireEvent.click(undoIcon);
    const dialog = screen.getByRole('dialog', { name: '撤销最近一次作答' });
    // 确认层写明将撤销的词/题型/结果
    expect(within(dialog).getByText('stable')).toBeVisible();
    expect(within(dialog).getByText(/理解题/)).toBeVisible();
    expect(within(dialog).getByText(/未通过/)).toBeVisible();

    // 取消不发请求
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '撤销最近一次作答' })).toBeNull(),
    );
    expect(apiCalls('/api/today/tasks/task-1/undo')).toHaveLength(0);

    // 确认：恰好一次，撤销后回活动会话（替换题新题面），完成摘要消失
    fireEvent.click(screen.getByRole('button', { name: '撤销最近一次作答' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '撤销最近一次作答' })).getByRole('button', {
        name: '撤销',
      }),
    );
    await waitFor(() => expect(apiCalls('/api/today/tasks/task-1/undo')).toHaveLength(1));
    // 回到活动会话：替换题（Recall Card）挂载、进度行出现、完成摘要消失；
    // 已撤销的原题不回放（result 为 null、canceled 条目不进分布）
    expect(await screen.findByRole('heading', { name: 'stable' })).toBeVisible();
    expect(await screen.findByText('0 / 1')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('heading', { name: '今天完成了' })).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(apiCalls('/api/today/tasks/task-1/undo')).toHaveLength(1); // 仍只有一次
  });

  it('完成页无可撤销作答时不渲染图标', async () => {
    stubApi({
      '/api/today': makeCompleted(),
      '/api/today/tasks': makeTasksResponse([makeSessionEntry(answeredTask, makeWrongAnswer())]),
    });
    renderTodayApp();
    await screen.findByRole('heading', { name: '今天完成了' });
    expect(screen.queryByRole('button', { name: '撤销最近一次作答' })).toBeNull();
  });
});
