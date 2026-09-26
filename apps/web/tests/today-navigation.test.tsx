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

/** 答对 t3（understanding 自动推进型）后桩切换：currentTask → t4 */
function stubAnsweredSession() {
  let answered = false;
  stubApi({
    '/api/today': () =>
      answered ? makeActive(t4, { completed: 3, total: 4 }) : makeActive(t3, { completed: 2, total: 4 }),
    '/api/today/tasks': () =>
      answered
        ? makeTasksResponse([
            makeSessionEntry(t1, makeCorrectAnswer()),
            makeSessionEntry(t2, makeWrongAnswer()),
            makeSessionEntry(t3, makeCorrectAnswer()),
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
      return makeCorrectAnswer();
    },
  });
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

  it('键盘 ←/→ 不再导航（滑动导航已删除）', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByText('第 3 / 4')).toBeVisible());
    expect(apiCalls('/api/today/tasks/task-3/later')).toHaveLength(0);
  });

  it('无稍后再做入口：任何键盘操作不产生 later 调用', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await new Promise((r) => setTimeout(r, 200));
    expect(apiCalls('/api/today/tasks/task-3/later')).toHaveLength(0);
  });

  it('列表点"当前"项 → 回到当前题 第 3 / 4', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const withinDialog = within(screen.getByRole('dialog', { name: '任务列表' }));
    fireEvent.click(withinDialog.getByRole('button', { name: /beta/ }));
    await screen.findByText('第 2 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /gamma/ }));
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

  it('答对不动 → 4s 自动跳题（基线行为）', async () => {
    stubAnsweredSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '稳定的' }));
    await screen.findByText('回答正确');
    // CORRECT_AUTO_ADVANCE_MS(4s) 后自动推进到 t4（未作答卡无词行 heading，以进度数字为推进信号）
    await screen.findByText('第 4 / 4', {}, { timeout: 7000 });
  }, 10_000);

  it('答对后回看返回当前：不再重新武装自动跳题', async () => {
    stubAnsweredSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '稳定的' }));
    await screen.findByText('回答正确');
    // 4s 内回看（取消本次倒计时），再回当前
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /beta/ }));
    await screen.findByText('第 2 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /gamma/ }));
    await screen.findByText('第 3 / 4');
    expect(screen.getByRole('heading', { name: 'gamma' })).toBeVisible();
    // 超过 CORRECT_AUTO_ADVANCE_MS：不得自动跳题（旧代码此处会推进到 delta）
    await new Promise((r) => setTimeout(r, 5000));
    expect(screen.getByRole('heading', { name: 'gamma' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'delta' })).toBeNull();
    // 手动推进（点击反馈区 = onAdvance）仍可进入下一题
    fireEvent.click(screen.getByText('回答正确'));
    await screen.findByText('第 4 / 4');
  }, 20_000);
});
