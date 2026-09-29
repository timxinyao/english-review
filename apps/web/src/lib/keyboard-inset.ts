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
  const open = (editing || currentViewport.open) && shrink > 100;
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
  const next = measureViewport();
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
  stopDebugPanel();
}

const pendingTodayTouch = new WeakSet<HTMLElement>();
let pendingTouchTimer = 0;

/** 触摸开始先无滚动聚焦；到 click 命中前保持真实输入与 dock 原位。 */
export function rememberTodayInputTouch(
  event: ReactPointerEvent<HTMLInputElement | HTMLTextAreaElement>,
): void {
  if (event.pointerType !== 'touch' || document.activeElement === event.currentTarget) return;
  const input = event.currentTarget;
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
