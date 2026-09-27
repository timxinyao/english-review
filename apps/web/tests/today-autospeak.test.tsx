import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));

const { speak } = await import('../src/lib/tts');

/** 会话 fixture：t1 对、t2 错、t3 当前未做（与 /api/today.currentTask 一致）、t4 未做（同 today-navigation.test.tsx） */
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

describe('会话自动发音', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('el:auto-pronounce');
  });

  it('默认开：当前卡到达自动读词一次', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    await waitFor(() => expect(vi.mocked(speak)).toHaveBeenCalledWith('gamma'));
    expect(vi.mocked(speak)).toHaveBeenCalledTimes(1);
  });

  it('localStorage 预置 0：不自动读', async () => {
    localStorage.setItem('el:auto-pronounce', '0');
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    await new Promise((r) => setTimeout(r, 100));
    expect(vi.mocked(speak)).not.toHaveBeenCalled();
  });

  it('开关按钮：点击关闭后切换不读，再开恢复；aria-pressed 反映状态', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    await waitFor(() => expect(vi.mocked(speak)).toHaveBeenCalledTimes(1));

    const btn = screen.getByRole('button', { name: '自动发音' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem('el:auto-pronounce')).toBe('0');
    // 开关点击不冒泡到外层"查看任务列表"按钮：列表弹层不弹开
    expect(screen.queryByRole('dialog', { name: '任务列表' })).toBeNull();

    // 关闭后切换（列表点 alpha 回看）不触发
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /alpha/ }));
    await screen.findByText('第 1 / 4');
    await new Promise((r) => setTimeout(r, 100));
    expect(vi.mocked(speak)).toHaveBeenCalledTimes(1);

    // 再开：下一次切换（列表点"当前"回 gamma）恢复自动读
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    // 点 gamma（当前）条目——within(dialog) 正规定位
    fireEvent.click(within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /gamma/ }));
    await screen.findByText('第 3 / 4');
    // 重开开关即刻读当前停留的词（alpha），随后切回 gamma 再读——共 3 次
    await waitFor(() => expect(vi.mocked(speak)).toHaveBeenCalledTimes(3));
    expect(vi.mocked(speak).mock.calls[1]?.[0]).toBe('alpha');
    expect(vi.mocked(speak).mock.calls[2]?.[0]).toBe('gamma');
  });
});
