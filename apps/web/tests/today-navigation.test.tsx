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

// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

/** 会话 fixture：t1 对、t2 错、t3 当前未做（与 /api/today.currentTask 一致）、t4 未做 */
const t1 = makeChoiceTask({ taskId: 'task-1', item: { id: 'i1', type: 'word', target: 'alpha', meaning: '甲', ipa: null, notes: null } });
const t2 = makeChoiceTask({ taskId: 'task-2', item: { id: 'i2', type: 'word', target: 'beta', meaning: '乙', ipa: '/beta/', notes: null } });
const t3 = makeChoiceTask({ taskId: 'task-3', item: { id: 'i3', type: 'word', target: 'gamma', meaning: '丙', ipa: null, notes: null } });
const t4 = makeChoiceTask({ taskId: 'task-4', item: { id: 'i4', type: 'word', target: 'delta', meaning: '丁', ipa: null, notes: null } });

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

  it('列表只读：未做条目置灰不可点；已完成可点回看', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const dialog = screen.getByRole('dialog', { name: '任务列表' });
    await waitFor(() => expect(dialog).toBeVisible());

    // 未做（delta，非当前）置灰不可点：点击不跳转、弹层不关闭
    const deltaBtn = within(dialog).getByRole('button', { name: /delta/ });
    expect(deltaBtn).toBeDisabled();
    fireEvent.click(deltaBtn);
    expect(screen.queryByRole('dialog', { name: '任务列表' })).toBeVisible();

    // 已完成（alpha）可点回看
    fireEvent.click(within(dialog).getByRole('button', { name: /alpha/ }));
    await screen.findByText('第 1 / 4');
    expect(screen.getByRole('heading', { name: 'alpha' })).toBeVisible();
  });

  it('已撤销任务：弹层置灰不可点', async () => {
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

  it('坏题入口在回看：自评自动前进后，列表回看已答题可标记坏题并返回当前题', async () => {
    let answered = false;
    stubApi({
      '/api/today': () =>
        answered ? makeActive(t4, { completed: 3, total: 4 }) : makeActive(t3, { completed: 2, total: 4 }),
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
      '/api/today/tasks/task-3/bad-question': { ok: true, progress: { completed: 2, total: 4 } },
    });
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    // 自评答错 → 留在当前卡看揭示 → 手动下一题到第 4 题
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '没想起来' }));
    expect(await screen.findByRole('button', { name: '下一题' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    await screen.findByText('第 4 / 4');
    expect(screen.getByRole('heading', { name: 'delta' })).toBeVisible();

    // 回看 t3（gamma）：冻结反馈 + 坏题入口；坏题必须提交到被回看的 task-3
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /gamma/ }),
    );
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '坏题' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-3/bad-question')).toHaveLength(1);
    });
    expect(apiCalls('/api/today/tasks/task-4/bad-question')).toHaveLength(0);
    // 坏题成功后返回当前题
    await screen.findByText('第 4 / 4');
    expect(screen.getByRole('heading', { name: 'delta' })).toBeVisible();
  });

  it('答对：refetch 成功后自动推进到下一题（评分即前进）', async () => {
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
        return makeCorrectAnswer({ outcomeSource: 'recalled' });
      },
    });
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '想起来了' }));
    // 无需点"下一题"：refetch 落地即到第 4 题
    await screen.findByText('第 4 / 4');
    expect(screen.getByRole('heading', { name: 'delta' })).toBeVisible();
  });

  it('任务列表弹层 portal 到 body：脱离业务容器层叠上下文；点遮罩可关闭', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const dialog = screen.getByRole('dialog', { name: '任务列表' });
    await waitFor(() => expect(dialog).toBeVisible());
    // portal：弹层直接挂在 body 下，而非 ProgressRow 容器内
    expect(dialog.parentElement).toBe(document.body);
    // 面板内部点击不关闭：stopPropagation 拦截，不冒泡到遮罩
    fireEvent.click(within(dialog).getByText('任务列表'));
    expect(dialog).toBeVisible();
    // 遮罩（弹层根节点本身）点击关闭。注：不能 fire 在 portal 容器 body 上——
    // React 合成事件沿组件树派发，portal 容器自身无 fiber，body 上的原生 click 不会触发遮罩 onClick
    fireEvent.click(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '任务列表' })).toBeNull());
  });
});
