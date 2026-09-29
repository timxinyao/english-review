import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeVisualViewport extends EventTarget {
  height = 700;
  offsetTop = 0;
}

async function loadModule() {
  vi.resetModules();
  return await import('../src/lib/keyboard-inset');
}

function setInnerHeight(value: number) {
  Object.defineProperty(window, 'innerHeight', { value, configurable: true, writable: true });
}

describe('keyboard-inset', () => {
  beforeEach(() => {
    setInnerHeight(844);
  });

  afterEach(() => {
    delete (window as { visualViewport?: unknown }).visualViewport;
    document.documentElement.style.removeProperty('--kb-inset');
  });

  it('键盘弹起：inset = round(innerHeight - vv.height - vv.offsetTop)，写入 --kb-inset', async () => {
    (window as { visualViewport?: unknown }).visualViewport = new FakeVisualViewport();
    const { useKeyboardInset } = await loadModule();
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(144);
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('144px');
  });

  it('键盘收起（差值为负）夹取为 0', async () => {
    const vv = new FakeVisualViewport();
    vv.height = 844;
    (window as { visualViewport?: unknown }).visualViewport = vv;
    const { useKeyboardInset } = await loadModule();
    renderHook(() => useKeyboardInset());
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('0px');
  });

  it('offsetTop 计入（iOS 键盘伴随视口上移）', async () => {
    const vv = new FakeVisualViewport();
    vv.height = 600;
    vv.offsetTop = 100;
    (window as { visualViewport?: unknown }).visualViewport = vv;
    const { useKeyboardInset } = await loadModule();
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(144); // 844 - 600 - 100
  });

  it('resize 更新数值与变量；最后一个退订后移除监听、变量不再变化', async () => {
    const vv = new FakeVisualViewport();
    const removeSpy = vi.spyOn(vv, 'removeEventListener');
    (window as { visualViewport?: unknown }).visualViewport = vv;
    const { useKeyboardInset } = await loadModule();
    const { result, unmount } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(144);

    vv.height = 500;
    vv.dispatchEvent(new Event('resize'));
    expect(result.current).toBe(344);
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('344px');

    unmount();
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    vv.height = 700;
    vv.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('344px');
  });

  it('无 visualViewport 时 no-op 返回 0', async () => {
    const { useKeyboardInset } = await loadModule();
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('');
  });
});
