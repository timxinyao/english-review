import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeActive,
  makeChoiceTask,
  makeSessionEntry,
  makeTasksResponse,
  renderTodayApp,
  stubApi,
} from './today-helpers';

const kb = { inset: 0, open: false, anchored: false, visibleHeight: 812, offsetTop: 0 };
vi.mock('../src/lib/keyboard-inset', () => ({
  useKeyboardInset: () => kb.inset,
  useKeyboardViewport: () => kb,
  useKeyboardPhase: () => (kb.open ? 'open' : kb.anchored ? 'focused' : 'idle'),
}));

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
    kb.open = false;
    kb.anchored = false;
    document.body.style.overflow = '';
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  it('iOS inset 为 0 但聚焦已开始时仍锁 body，卸载恢复', async () => {
    kb.anchored = true;
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

  it('键盘期不持续调用 scrollTo 与 Safari 聚焦滚动竞争', async () => {
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    kb.anchored = true;
    kb.open = true;
    renderActiveSession();
    await screen.findByRole('heading', { name: 'stable' });
    Object.defineProperty(window, 'scrollY', { value: 120, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(scrollToSpy).not.toHaveBeenCalled();
    cleanup();
    scrollToSpy.mockRestore();
  });
});
