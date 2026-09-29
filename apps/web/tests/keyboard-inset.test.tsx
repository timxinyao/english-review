import { cleanup, renderHook } from '@testing-library/react';
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
    // 先卸载 hook（触发各模块实例 stop 移除 window/vv 监听），
    // 否则跨用例泄漏的 publish 会踩共享的 --kb-inset
    cleanup();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.querySelectorAll('body > input').forEach((input) => input.remove());
    delete (window as { visualViewport?: unknown }).visualViewport;
    document.documentElement.style.removeProperty('--kb-inset');
    document.documentElement.style.removeProperty('--kb-visible-height');
    document.documentElement.style.removeProperty('--kb-baseline-height');
    document.documentElement.style.removeProperty('--kb-offset-top');
    window.history.replaceState(null, '', '/');
  });

  it('仅在 kbdebug 查询参数下显示真实视口与卡片几何，退出后移除', async () => {
    window.history.replaceState(null, '', '/today?kbdebug=1');
    const vv = new FakeVisualViewport();
    vv.height = 389;
    vv.offsetTop = 123;
    (window as { visualViewport?: unknown }).visualViewport = vv;
    const { useKeyboardViewport } = await loadModule();
    const { unmount } = renderHook(() => useKeyboardViewport());

    const panel = document.querySelector('[data-kb-debug]');
    expect(panel?.textContent).toContain('vv.height 389');
    expect(panel?.textContent).toContain('vv.offsetTop 123');
    expect(panel?.textContent).toContain('scrollY');

    unmount();
    expect(document.querySelector('[data-kb-debug]')).toBeNull();
  });

  it('主屏 PWA 无地址栏时可在应用内切换诊断面板', async () => {
    (window as { visualViewport?: unknown }).visualViewport = new FakeVisualViewport();
    const { useKeyboardViewport, toggleKeyboardDebug } = await loadModule();
    const { unmount } = renderHook(() => useKeyboardViewport());

    expect(document.querySelector('[data-kb-debug]')).toBeNull();
    toggleKeyboardDebug();
    expect(document.querySelector('[data-kb-debug]')).not.toBeNull();
    expect(window.location.search).toBe('?kbdebug=1');

    toggleKeyboardDebug();
    expect(document.querySelector('[data-kb-debug]')).toBeNull();
    expect(window.location.search).toBe('');
    unmount();
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

  it('iOS 26 回弹：innerHeight 变化无 vv 事件时经 window resize/scroll 重算', async () => {
    const vv = new FakeVisualViewport();
    vv.height = 389;
    (window as { visualViewport?: unknown }).visualViewport = vv;
    const { useKeyboardInset } = await loadModule();
    const { result, unmount } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(455); // 844 - 389

    // iOS 先把布局视口缩到 389（伴随 vv 事件）→ inset 归 0
    setInnerHeight(389);
    vv.dispatchEvent(new Event('resize'));
    expect(result.current).toBe(0);

    // 布局视口回弹 812，只有 window 事件、无 vv 事件 → 必须重算回 423
    setInnerHeight(812);
    window.dispatchEvent(new Event('resize'));
    expect(result.current).toBe(423);
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('423px');

    // 卸载后 window 监听一并移除，不再重算
    unmount();
    setInnerHeight(389);
    window.dispatchEvent(new Event('scroll'));
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('423px');
  });

  it('iOS 键盘平移视口且 innerHeight 同步缩小时仍保留键盘遮挡高度', async () => {
    const vv = new FakeVisualViewport();
    vv.height = 812;
    (window as { visualViewport?: unknown }).visualViewport = vv;
    setInnerHeight(812);
    const { useKeyboardInset } = await loadModule();
    const { result } = renderHook(() => useKeyboardInset());

    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    setInnerHeight(389);
    vv.height = 389;
    vv.offsetTop = 423;
    vv.dispatchEvent(new Event('resize'));

    expect(result.current).toBe(423);
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('423px');
    input.remove();
  });

  it('聚焦先固定 Today，键盘期间按视觉视口定位，失焦后等键盘收起才解锁', async () => {
    const vv = new FakeVisualViewport();
    vv.height = 812;
    (window as { visualViewport?: unknown }).visualViewport = vv;
    setInnerHeight(812);
    const { useKeyboardViewport } = await loadModule();
    const { result } = renderHook(() => useKeyboardViewport());
    expect(result.current.anchored).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--kb-baseline-height')).toBe('812px');

    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(result.current.anchored).toBe(true);

    setInnerHeight(389);
    vv.height = 389;
    vv.offsetTop = 423;
    vv.dispatchEvent(new Event('resize'));
    expect(result.current).toMatchObject({
      open: true,
      anchored: true,
      visibleHeight: 389,
      offsetTop: 423,
    });
    expect(document.documentElement.style.getPropertyValue('--kb-visible-height')).toBe('389px');
    expect(document.documentElement.style.getPropertyValue('--kb-baseline-height')).toBe('812px');
    expect(document.documentElement.style.getPropertyValue('--kb-offset-top')).toBe('423px');

    input.blur();
    expect(result.current.open).toBe(true);
    vv.height = 812;
    vv.offsetTop = 0;
    setInnerHeight(812);
    vv.dispatchEvent(new Event('resize'));
    expect(result.current).toMatchObject({ open: false, anchored: false });
    input.remove();
  });
});
