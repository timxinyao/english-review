import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiCalls,
  makeActive,
  makeChoiceTask,
  makeCorrectAnswer,
  makeSessionEntry,
  makeTasksResponse,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

/** 会话 fixture：t1 对、t2 错、t3 当前未做（与 /api/today.currentTask 一致）、t4 未做 */
const t1 = makeChoiceTask({ taskId: 'task-1', item: { id: 'i1', type: 'word', target: 'alpha', meaning: '甲', ipa: null } });
const t2 = makeChoiceTask({ taskId: 'task-2', item: { id: 'i2', type: 'word', target: 'beta', meaning: '乙', ipa: '/beta/' } });
const t3 = makeChoiceTask({ taskId: 'task-3', item: { id: 'i3', type: 'word', target: 'gamma', meaning: '丙', ipa: null } });
const t4 = makeChoiceTask({ taskId: 'task-4', item: { id: 'i4', type: 'word', target: 'delta', meaning: '丁', ipa: null } });

function stubSession() {
  stubApi({
    '/api/today': makeActive(t3, { completed: 2, total: 4 }),
    '/api/today/tasks': makeTasksResponse([
      makeSessionEntry(t1, makeCorrectAnswer()),
      makeSessionEntry(t2, makeWrongAnswer()),
      makeSessionEntry(t3, null),
      makeSessionEntry(t4, null),
    ]),
  });
}

function swipeBy(dx: number): void {
  const el = document.querySelector('[data-swipe-deck]');
  if (!(el instanceof HTMLElement)) throw new Error('deck 未渲染');
  fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 200 + dx / 2, clientY: 300 }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 200 + dx, clientY: 300 }] });
}

describe('Today 会话导航', () => {
  beforeEach(() => vi.clearAllMocks());

  it('进度：当前位置数字 第 3 / 4；完成段着色、未完成灰、当前段高亮', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    expect(document.querySelectorAll('[data-seg="done"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-seg="todo"]')).toHaveLength(2);
    const current = document.querySelector('[data-current="true"]');
    expect(current).not.toBeNull();
    expect(current!.getAttribute('data-seg')).toBe('todo');
  });

  it('左滑回看：数字变 第 2 / 4，卡片只读且显示单词行', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    swipeBy(-120);
    await screen.findByText('第 2 / 4');
    expect(screen.getByRole('heading', { name: 'beta' })).toBeVisible();
    // 只读：选项禁用
    const option = screen.getByRole('button', { name: '稳定的' });
    expect(option).toBeDisabled();
  });

  it('列表弹层：显示全部 4 个任务与状态；点未完成任务跳去做并可作答', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const dialog = screen.getByRole('dialog', { name: '任务列表' });
    await waitFor(() => expect(dialog).toBeVisible());
    const withinDialog = within(dialog);
    for (const w of ['alpha', 'beta', 'gamma', 'delta']) {
      expect(withinDialog.getByText(w)).toBeVisible();
    }
    expect(withinDialog.getByText('对')).toBeVisible();
    expect(withinDialog.getByText('错')).toBeVisible();
    expect(withinDialog.getByText('当前')).toBeVisible();
    expect(withinDialog.getByText('未做')).toBeVisible();

    fireEvent.click(withinDialog.getByRole('button', { name: /delta/ }));
    await screen.findByText('第 4 / 4');
    // 跳到的未完成任务可作答：选项可点并提交该 taskId
    stubApi({
      '/api/today': makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, makeCorrectAnswer()),
        makeSessionEntry(t2, makeWrongAnswer()),
        makeSessionEntry(t3, null),
        makeSessionEntry(t4, null),
      ]),
      '/api/today/tasks/task-4/answer': makeCorrectAnswer(),
    });
    fireEvent.click(screen.getByRole('button', { name: '稳定的' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-4/answer')).toHaveLength(1);
    });
  });

  it('已撤销任务：弹层置灰不可点，滑动跳过', async () => {
    stubApi({
      '/api/today': makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, makeCorrectAnswer()),
        makeSessionEntry(t2, makeWrongAnswer()),
        makeSessionEntry(t3, null, true), // 假设 t3 被撤销（fixture 便于触发）
        makeSessionEntry(t4, null),
      ]),
    });
    renderTodayApp();
    await screen.findByText('第 3 / 4'); // 批量列表就绪后才会出现（避免 /\/ 4/ 命中进度兜底文案的竞态）
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const dialog = screen.getByRole('dialog', { name: '任务列表' });
    const canceledBtn = within(dialog).getByRole('button', { name: /gamma/ });
    expect(canceledBtn).toBeDisabled();
    fireEvent.click(canceledBtn);
    expect(screen.queryByRole('dialog', { name: '任务列表' })).toBeVisible(); // 未关闭=未跳转
  });

  it('当前题未作答右滑 → 稍后再做（later 调用，回归）', async () => {
    stubApi({
      '/api/today': makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, makeCorrectAnswer()),
        makeSessionEntry(t2, makeWrongAnswer()),
        makeSessionEntry(t3, null),
        makeSessionEntry(t4, null),
      ]),
      '/api/today/tasks/task-3/later': { ok: true, progress: { completed: 2, total: 4 } },
    });
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    swipeBy(120);
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-3/later')).toHaveLength(1);
    });
  });

  it('键盘 ← 回看、→ 返回当前', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await screen.findByText('第 2 / 4');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await screen.findByText('第 3 / 4');
  });

  it('冻结错配回归：答错后 refetch 落地仍显示原题反馈，坏题提交到原题 taskId', async () => {
    // 作答后桩切换快照：t3 完成(fail)、currentTask=t4、entries 更新（模拟 invalidate refetch 落地）
    let answered = false;
    stubApi({
      '/api/today': () =>
        answered
          ? makeActive(t4, { completed: 3, total: 4 })
          : makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': () =>
        answered
          ? makeTasksResponse([
              makeSessionEntry(t1, makeCorrectAnswer()),
              makeSessionEntry(t2, makeWrongAnswer()),
              makeSessionEntry(t3, makeWrongAnswer()),
              makeSessionEntry(t4, null),
            ])
          : makeTasksResponse([
              makeSessionEntry(t1, makeCorrectAnswer()),
              makeSessionEntry(t2, makeWrongAnswer()),
              makeSessionEntry(t3, null),
              makeSessionEntry(t4, null),
            ]),
      '/api/today/tasks/task-3/answer': () => {
        answered = true;
        return makeWrongAnswer();
      },
      '/api/today/tasks/task-3/bad-question': { ok: true, progress: { completed: 3, total: 4 } },
    });
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '摇晃的' }));
    await screen.findByText('回答错误');
    // 等 invalidate refetch 落地（t3 变为已完成段），反馈仍冻结在 t3 的题面上
    await waitFor(() => expect(document.querySelectorAll('[data-seg="done"]')).toHaveLength(3));
    expect(screen.getByRole('heading', { name: 'gamma' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'delta' })).toBeNull();
    // 坏题必须 mutate 到冻结的旧题 task-3，而非 refetch 后的当前题 task-4
    fireEvent.click(screen.getByRole('button', { name: '坏题' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-3/bad-question')).toHaveLength(1);
    });
    expect(apiCalls('/api/today/tasks/task-4/bad-question')).toHaveLength(0);
  });

  it('回看到最前后继续左滑 → 停留 第 1 / 4（边界回弹）', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const withinDialog = within(screen.getByRole('dialog', { name: '任务列表' }));
    fireEvent.click(withinDialog.getByRole('button', { name: /alpha/ }));
    await screen.findByText('第 1 / 4');
    swipeBy(-120);
    await waitFor(() => expect(screen.getByText('第 1 / 4')).toBeVisible());
  });

  it('跳到最后一条后右滑越过末尾 → 回到当前题 第 3 / 4', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const withinDialog = within(screen.getByRole('dialog', { name: '任务列表' }));
    fireEvent.click(withinDialog.getByRole('button', { name: /delta/ }));
    await screen.findByText('第 4 / 4');
    swipeBy(120);
    await screen.findByText('第 3 / 4');
  });

  it('左滑回看跳过已撤销条目 → 落在 第 1 / 4', async () => {
    stubApi({
      '/api/today': makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, makeCorrectAnswer()),
        makeSessionEntry(t2, makeWrongAnswer(), true), // t2 已撤销：回看路径跳过 2 号位
        makeSessionEntry(t3, null),
        makeSessionEntry(t4, null),
      ]),
    });
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    swipeBy(-120);
    await screen.findByText('第 1 / 4');
    expect(screen.getByRole('heading', { name: 'alpha' })).toBeVisible();
  });
});
