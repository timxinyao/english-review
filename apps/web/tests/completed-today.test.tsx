import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeActive,
  makeCanceledEntry,
  makeChoiceTask,
  makeCompleted,
  makeCorrectAnswer,
  makeSessionEntry,
  makeTasksResponse,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
  apiCalls,
} from './today-helpers';
import { api } from '../src/lib/api';

afterEach(cleanup);

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const t1 = makeChoiceTask({
  taskId: 'task-1',
  item: { id: 'i1', type: 'word', target: 'alpha', meaning: '甲', ipa: null, notes: null },
});
const t2 = makeChoiceTask({
  taskId: 'task-2',
  item: { id: 'i2', type: 'word', target: 'beta', meaning: '乙', ipa: null, notes: null },
});
const t3 = makeChoiceTask({
  taskId: 'task-3',
  item: { id: 'i3', type: 'word', target: 'gamma', meaning: '丙', ipa: null, notes: null },
});

describe('完成页今日回顾', () => {
  it('答错在前、答对次之、已撤销最后；链接指向 Library 详情', async () => {
    stubApi({
      '/api/today': {
        status: 'completed',
        summary: {
          totalTasks: 3,
          pass: 1,
          basicPass: 0,
          fail: 1,
          newItemsStarted: 0,
          recommendRead: false,
        },
      },
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, makeCorrectAnswer()),
        makeSessionEntry(t2, makeWrongAnswer()),
        makeCanceledEntry(t3),
      ]),
    });
    renderTodayApp();
    await screen.findByText('今天完成了');

    // 回顾列表来自独立的 /api/today/tasks 查询，晚于完成摘要落地，需等待
    const list = await screen.findByRole('list', { name: '今日回顾' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('beta')).toBeVisible(); // 答错在前
    expect(within(rows[1]!).getByText('alpha')).toBeVisible();
    expect(within(rows[2]!).getByText('已撤销')).toBeVisible();

    // 链接跳 Library 详情（MemoryRouter 仅挂 /today 路由，点击即卸载；断言 href 目标）
    const firstLink = within(rows[0]!).getByRole('link', { name: /beta/ });
    expect(firstLink).toHaveAttribute('href', '/library/i2');
  });
});

describe('完成页再学一批', () => {
  // api mock 的 calls 跨用例累积：计数断言前先清（块体避免把 mock 当返回值注册成 cleanup）
  beforeEach(() => {
    vi.mocked(api).mockClear();
  });

  it('剩余额度>0：显示"再学 N 个新词"，点击 POST extend 并 invalidate 回 active', async () => {
    let statusCalls = 0;
    stubApi({
      // 首次 GET completed（带剩余额度）；extend 成功 invalidate 后 refetch 返回 active
      '/api/today': () =>
        statusCalls++ === 0 ? makeCompleted({}, 10) : makeActive(null, { completed: 6, total: 16 }),
      '/api/today/extend': makeActive(null, { completed: 6, total: 16 }),
    });
    renderTodayApp();

    const btn = await screen.findByRole('button', { name: '再学 10 个新词' });
    expect(btn).toBeVisible();
    fireEvent.click(btn);

    await waitFor(() => expect(apiCalls('/api/today/extend')).toHaveLength(1));
    expect(apiCalls('/api/today/extend')[0]!.init?.method).toBe('POST');
    // invalidate → status refetch 翻转 active → 完成摘要卸载
    await waitFor(() => expect(statusCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByText('今天完成了')).toBeNull());
  });

  it('remainingNewQuota=null（不限制）：显示"再学 10 个新词"', async () => {
    stubApi({ '/api/today': makeCompleted() });
    renderTodayApp();

    expect(await screen.findByRole('button', { name: '再学 10 个新词' })).toBeVisible();
  });

  it('remainingNewQuota=0：无按钮', async () => {
    stubApi({ '/api/today': makeCompleted({}, 0) });
    renderTodayApp();

    await screen.findByText('今天完成了');
    expect(screen.queryByRole('button', { name: /再学/ })).toBeNull();
  });

  it('extend 失败：按钮下方显示错误文案，可重试', async () => {
    let fail = true;
    let extended = false;
    const active = () => makeActive(null, { completed: 6, total: 16 });
    stubApi({
      '/api/today': () => (extended ? active() : makeCompleted({}, 10)),
      '/api/today/extend': () => {
        if (fail) return Promise.reject(new Error('今日新学习额度已用完'));
        extended = true;
        return active();
      },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '再学 10 个新词' }));
    expect(await screen.findByText('今日新学习额度已用完')).toBeVisible();
    expect(screen.getByRole('button', { name: '再学 10 个新词' })).toBeEnabled();

    // 重试成功 → invalidate → 回 active 会话
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '再学 10 个新词' }));
    await waitFor(() => expect(screen.queryByText('今天完成了')).toBeNull());
    expect(apiCalls('/api/today/extend')).toHaveLength(2);
  });
});
