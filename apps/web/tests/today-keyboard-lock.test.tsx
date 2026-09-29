import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeActive, makeChoiceTask, makeSessionEntry, makeTasksResponse, renderTodayApp, stubApi } from './today-helpers';

const kb = { inset: 0 };
vi.mock('../src/lib/keyboard-inset', () => ({ useKeyboardInset: () => kb.inset }));

// ActiveSession 切卡会自动 speak：mock 掉真实 tts（jsdom 无 AudioContext，真实调用会产生未处理 rejection）
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

function renderActiveSession() {
  const task = makeChoiceTask();
  stubApi({
    '/api/today': () => makeActive(task),
    '/api/today/tasks': () => makeTasksResponse([makeSessionEntry(task, null)]),
  });
  renderTodayApp();
}

describe('Today 键盘期 body 滚动锁', () => {
  beforeEach(() => {
    kb.inset = 0;
    document.body.style.overflow = '';
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  it('键盘弹起（inset>0）锁 body，卸载恢复', async () => {
    kb.inset = 320;
    renderActiveSession();
    await screen.findByRole('heading', { name: 'stable' });
    expect(document.body.style.overflow).toBe('hidden');
    cleanup();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('键盘收起（inset=0）不锁', async () => {
    renderActiveSession();
    await screen.findByRole('heading', { name: 'stable' });
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('锁定期把顶起的 scrollY 立即回正并持续钉回 0，卸载后不再干预', async () => {
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    kb.inset = 320;
    renderActiveSession();
    await screen.findByRole('heading', { name: 'stable' });
    // iOS 键盘 reveal 已把页面顶起的场景：锁定生效即回正一次
    expect(scrollToSpy).toHaveBeenCalledWith(0, 0);

    // 锁定期内再次被顶起（键盘动画/箭头工具条）：scroll 监听持续钉回
    Object.defineProperty(window, 'scrollY', { value: 120, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(scrollToSpy).toHaveBeenCalledTimes(2);

    cleanup();
    window.dispatchEvent(new Event('scroll'));
    expect(scrollToSpy).toHaveBeenCalledTimes(2); // 卸载后不再干预
    scrollToSpy.mockRestore();
  });
});
