import {
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { flushSync } from 'react-dom';

/**
 * iOS 软键盘避让（spec docs/superpowers/specs/2026-09-29-keyboard-inset-design.md）：
 * 把可视高度与无键盘高度写进 <html> CSS 变量供 Today 布局消费，
 * 并暴露键盘阶段供滚动锁和导航使用。
 * 单例：首个订阅启动监听，最后一个退订移除监听；app 生命周期内常驻。
 * 无 window.visualViewport（jsdom/旧浏览器）时安全 no-op。
 */
export interface KeyboardViewport {
  inset: number;
  visibleHeight: number;
  offsetTop: number;
  open: boolean;
  anchored: boolean;
}

const emptyViewport: KeyboardViewport = {
  inset: 0,
  visibleHeight: 0,
  offsetTop: 0,
  open: false,
  anchored: false,
};

let currentViewport = emptyViewport;
let unfocusedVisualHeight = 0;
const subscribers = new Set<() => void>();
let debugPanel: HTMLPreElement | null = null;
let debugFrame = 0;
const dismissedTodayInputs = new WeakSet<HTMLElement>();
let dismissedScrollFrame = 0;

function resetDismissedTodayScroll(input: HTMLElement): void {
  if (!input.isConnected || !input.closest('[data-today-route] .h-today-viewport')) return;
  if (window.scrollX || window.scrollY || window.visualViewport?.offsetTop) {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }
}

function updateDebugPanel(): void {
  if (!debugPanel) return;
  const vv = window.visualViewport;
  const rect = (selector: string) => {
    const element = document.querySelector(selector);
    if (!element) return '—';
    const box = element.getBoundingClientRect();
    return `${Math.round(box.top)}..${Math.round(box.bottom)}`;
  };
  debugPanel.textContent = [
    `innerHeight ${window.innerHeight}  screen.height ${window.screen.height}`,
    `vv.height ${Math.round(vv?.height ?? 0)}  vv.offsetTop ${Math.round(vv?.offsetTop ?? 0)}`,
    `vv.pageTop ${Math.round(vv?.pageTop ?? 0)}  scrollY ${Math.round(window.scrollY)}`,
    `html.scrollTop ${document.documentElement.scrollTop}  body.scrollTop ${document.body.scrollTop}`,
    `phase ${currentViewport.open ? 'open' : currentViewport.anchored ? 'focused' : 'idle'}`,
    `header ${rect('[data-today-route] header')}  card ${rect('.h-today-viewport')}`,
    `input ${rect('input:focus, textarea:focus')}  prime ${document.documentElement.style.getPropertyValue('--kb-prime-visible-height') || 'none'}`,
  ].join('\n');
  debugFrame = window.requestAnimationFrame(updateDebugPanel);
}

function startDebugPanel(): void {
  if (debugPanel) return;
  debugPanel = document.createElement('pre');
  debugPanel.className = 'keyboard-viewport-debug';
  debugPanel.setAttribute('data-kb-debug', '');
  document.body.append(debugPanel);
  updateDebugPanel();
}

function stopDebugPanel(): void {
  window.cancelAnimationFrame(debugFrame);
  debugPanel?.remove();
  debugPanel = null;
}

/** 主屏 PWA 没有地址栏：五击 Foxi 标题可切换临时诊断，不刷新会话。 */
export function toggleKeyboardDebug(): void {
  const url = new URL(window.location.href);
  if (debugPanel) {
    stopDebugPanel();
    url.searchParams.delete('kbdebug');
  } else {
    url.searchParams.set('kbdebug', '1');
    startDebugPanel();
  }
  window.history.replaceState(window.history.state, '', url);
}

function isEditing(): boolean {
  const focused = document.activeElement;
  return (
    focused instanceof HTMLElement &&
    (focused.matches('input, textarea, select') || focused.isContentEditable)
  );
}

function measureViewport(): KeyboardViewport {
  const vv = window.visualViewport;
  if (!vv) return emptyViewport;
  const editing = isEditing();
  if (unfocusedVisualHeight === 0) unfocusedVisualHeight = vv.height;
  const shrink = Math.max(0, unfocusedVisualHeight - vv.height);
  // focusout 可以早于键盘收起；只要视觉视口还缩着，就继续保持顶部锚定。
  // 开启需明显缩小；已开启后等到全高恢复才结束，避免收起末段提前解锁。
  const open = (editing || currentViewport.open) && shrink > (currentViewport.open ? 1 : 100);
  const anchored = editing || open;
  if (!anchored) unfocusedVisualHeight = vv.height;
  const layoutInset = window.innerHeight - vv.height - vv.offsetTop;
  return {
    inset: Math.max(0, Math.round(Math.max(layoutInset, open ? shrink : 0))),
    visibleHeight: Math.round(vv.height),
    offsetTop: Math.round(vv.offsetTop),
    open,
    anchored,
  };
}

function publish(event?: Event) {
  let next = measureViewport();
  const focused = document.activeElement;
  // 输入法的收起按钮可能不触发 blur。只在已打开的键盘恢复全高后，
  // 释放 Today 答题框的残留焦点，才能清除预定位并恢复导航；草稿不变。
  if (
    currentViewport.open &&
    !next.open &&
    focused instanceof HTMLElement &&
    focused.matches('input, textarea') &&
    focused.closest('[data-today-route] .h-today-viewport')
  ) {
    dismissedTodayInputs.add(focused);
    focused.blur();
    next = measureViewport();
    // 等焦点释放和 React 布局恢复后，仅清理这次系统收起遗留的根滚动。
    // 不在键盘动画中追帧补偿；快速再次输入时也不能触发迟到的归零。
    window.cancelAnimationFrame(dismissedScrollFrame);
    dismissedScrollFrame = window.requestAnimationFrame(() => {
      dismissedScrollFrame = 0;
      if (!currentViewport.anchored && !isEditing()) resetDismissedTodayScroll(focused);
    });
  }
  if (!next.anchored) {
    document.documentElement.removeAttribute('data-today-keyboard-primed');
    document.documentElement.style.removeProperty('--kb-prime-visible-height');
  }
  document.documentElement.style.setProperty('--kb-inset', `${next.inset}px`);
  document.documentElement.style.setProperty('--kb-visible-height', `${next.visibleHeight}px`);
  document.documentElement.style.setProperty(
    '--kb-baseline-height',
    `${Math.round(unfocusedVisualHeight)}px`,
  );
  document.documentElement.style.setProperty('--kb-offset-top', `${next.offsetTop}px`);
  if (
    next.inset === currentViewport.inset &&
    next.visibleHeight === currentViewport.visibleHeight &&
    next.offsetTop === currentViewport.offsetTop &&
    next.open === currentViewport.open &&
    next.anchored === currentViewport.anchored
  )
    return;
  currentViewport = next;
  // 初始化订阅可能发生在 React 生命周期里，此时不能 flushSync；真实视口/焦点事件
  // 则同步通知，避免键盘动画的一帧内布局与状态不一致。
  if (event) flushSync(() => subscribers.forEach((notify) => notify()));
  else subscribers.forEach((notify) => notify());
}

function start() {
  const vv = window.visualViewport;
  if (!vv) return;
  if (new URLSearchParams(window.location.search).get('kbdebug') === '1') startDebugPanel();
  vv.addEventListener('resize', publish);
  vv.addEventListener('scroll', publish);
  // iOS 26：innerHeight 随键盘异步变化（布局视口先缩后回弹），且该变化
  // 可能不伴随任何 visualViewport 事件——补听 window 事件保证重算，
  // 否则 inset 卡死在旧值（真机诊断 2026-09-29：ih 回弹 812 而 vv 仍 389）
  window.addEventListener('resize', publish);
  window.addEventListener('scroll', publish);
  window.addEventListener('focusin', publish);
  window.addEventListener('focusout', publish);
  publish();
}

function stop() {
  const vv = window.visualViewport;
  if (!vv) return;
  vv.removeEventListener('resize', publish);
  vv.removeEventListener('scroll', publish);
  window.removeEventListener('resize', publish);
  window.removeEventListener('scroll', publish);
  window.removeEventListener('focusin', publish);
  window.removeEventListener('focusout', publish);
  document.documentElement.removeAttribute('data-today-keyboard-primed');
  document.documentElement.removeAttribute('data-today-touch-pending');
  document.documentElement.style.removeProperty('--kb-prime-visible-height');
  window.clearTimeout(pendingTouchTimer);
  window.cancelAnimationFrame(dismissedScrollFrame);
  stopDebugPanel();
}

const pendingTodayTouch = new WeakSet<HTMLElement>();
let pendingTouchTimer = 0;

/** 触摸开始先无滚动聚焦；到 click 命中前保持真实输入与 dock 原位。 */
export function rememberTodayInputTouch(
  event: ReactPointerEvent<HTMLInputElement | HTMLTextAreaElement>,
): void {
  if (event.pointerType !== 'touch') return;
  const input = event.currentTarget;
  if (document.activeElement === input && currentViewport.open) return;
  if (dismissedTodayInputs.delete(input)) {
    window.cancelAnimationFrame(dismissedScrollFrame);
    // WebKit 的滚动恢复可能晚于 resize；下一次原位聚焦前再检查一次。
    if (!currentViewport.open) resetDismissedTodayScroll(input);
  }
  pendingTodayTouch.add(input);
  document.documentElement.setAttribute('data-today-touch-pending', '');
  window.clearTimeout(pendingTouchTimer);
  pendingTouchTimer = window.setTimeout(() => {
    pendingTodayTouch.delete(input);
    document.documentElement.removeAttribute('data-today-touch-pending');
  }, 750);
  input.focus({ preventScroll: true });
}

/** click 已命中真实输入且原生聚焦完成后，才移动底部 dock。 */
export function positionTodayDockAfterClick(
  event: ReactMouseEvent<HTMLInputElement | HTMLTextAreaElement>,
): void {
  if (!pendingTodayTouch.delete(event.currentTarget)) return;
  window.clearTimeout(pendingTouchTimer);
  document.documentElement.removeAttribute('data-today-touch-pending');
  if (document.activeElement !== event.currentTarget) return;
  const baseline = unfocusedVisualHeight || window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty(
    '--kb-prime-visible-height',
    `${Math.round(baseline * 0.48)}px`,
  );
  document.documentElement.setAttribute('data-today-keyboard-primed', '');
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  if (subscribers.size === 1) start();
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) stop();
  };
}

const getInsetSnapshot = () => currentViewport.inset;
const getViewportSnapshot = () => currentViewport;
const getPhaseSnapshot = () =>
  currentViewport.open ? 'open' : currentViewport.anchored ? 'focused' : 'idle';

export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, getInsetSnapshot, () => 0);
}

export function useKeyboardViewport(): KeyboardViewport {
  return useSyncExternalStore(subscribe, getViewportSnapshot, () => emptyViewport);
}

/** 几何每帧通过 CSS 变量更新；React 只在焦点/键盘阶段变化时重渲染。 */
export function useKeyboardPhase(): 'idle' | 'focused' | 'open' {
  return useSyncExternalStore(subscribe, getPhaseSnapshot, () => 'idle');
}
