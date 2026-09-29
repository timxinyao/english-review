import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

/**
 * iOS 软键盘避让（spec docs/superpowers/specs/2026-09-29-keyboard-inset-design.md）：
 * 把键盘遮挡高度写进 <html> 的 --kb-inset 供布局消费（Today 卡高公式），
 * 并暴露 useKeyboardInset() 数值（Today 键盘期滚动锁）。
 * 单例：首个订阅启动监听，最后一个退订移除监听；app 生命周期内常驻。
 * 无 window.visualViewport（jsdom/旧浏览器）时安全 no-op。
 */
let currentInset = 0;
const subscribers = new Set<() => void>();

function computeInset(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

function publish() {
  const next = computeInset();
  // 变量每次直写（含归 0），不做节流——键盘动画期连续 resize 写入本身廉价（spec）；
  // 不能因“数值未变”跳过，否则首个快照为 0 时 --kb-inset 永远不会被写成 '0px'
  document.documentElement.style.setProperty('--kb-inset', `${next}px`);
  if (next === currentInset) return;
  currentInset = next;
  // flushSync：visualViewport 事件里同步完成重渲染（并发根默认微任务级异步，
  // 布局需在当帧收敛，消费方也可同步断言数值）
  flushSync(() => {
    subscribers.forEach((notify) => notify());
  });
}

function start() {
  const vv = window.visualViewport;
  if (!vv) return;
  vv.addEventListener('resize', publish);
  vv.addEventListener('scroll', publish);
  // iOS 26：innerHeight 随键盘异步变化（布局视口先缩后回弹），且该变化
  // 可能不伴随任何 visualViewport 事件——补听 window 事件保证重算，
  // 否则 inset 卡死在旧值（真机诊断 2026-09-29：ih 回弹 812 而 vv 仍 389）
  window.addEventListener('resize', publish);
  window.addEventListener('scroll', publish);
  publish();
}

function stop() {
  const vv = window.visualViewport;
  if (!vv) return;
  vv.removeEventListener('resize', publish);
  vv.removeEventListener('scroll', publish);
  window.removeEventListener('resize', publish);
  window.removeEventListener('scroll', publish);
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  if (subscribers.size === 1) start();
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) stop();
  };
}

const getSnapshot = () => currentInset;

export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
