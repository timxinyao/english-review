import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeCanceledEntry,
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

const t1 = makeChoiceTask({ taskId: 'task-1', item: { id: 'i1', type: 'word', target: 'alpha', meaning: '甲', ipa: null, notes: null } });
const t2 = makeChoiceTask({ taskId: 'task-2', item: { id: 'i2', type: 'word', target: 'beta', meaning: '乙', ipa: null, notes: null } });
const t3 = makeChoiceTask({ taskId: 'task-3', item: { id: 'i3', type: 'word', target: 'gamma', meaning: '丙', ipa: null, notes: null } });

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
