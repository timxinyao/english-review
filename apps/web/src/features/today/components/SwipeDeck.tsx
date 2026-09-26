import { useEffect, useRef, type ReactNode } from 'react';

const THRESHOLD_PX = 60;
/** 水平判定比例：|dx| 必须超过 |dy| 的 1.5 倍 */
const H_RATIO = 1.5;
/** 触摸起点命中交互元素时不接管手势（点击/输入/弹层归它们自己） */
const IGNORE_SELECTOR = 'button, input, textarea, select, a, [role="dialog"], [data-no-swipe]';

interface SwipeDeckProps {
  onSwipeLeft: () => boolean | void;
  onSwipeRight: () => boolean | void;
  className?: string;
  children: ReactNode;
}

/**
 * 页面级滑动翻页容器：手势监听在整个会话区块（进度行+卡片+留白），
 * 跟手 translateX/rotateY 位移只作用于内部 [data-swipe-card] 目标。
 * 松手超过阈值翻页（旧卡滑出、新卡对侧滑入），否则回弹；handler 返回 false = 边界回弹。
 * prefers-reduced-motion 时跳过所有动画，仅保留手势判定。
 */
export function SwipeDeck({ onSwipeLeft, onSwipeRight, className, children }: SwipeDeckProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  /** 翻页滑出动画的 setTimeout id；新手势/卸载时取消，避免旧回调打断新一轮动画 */
  const slideTimer = useRef<number | null>(null);

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clearSlideTimer() {
    if (slideTimer.current !== null) {
      window.clearTimeout(slideTimer.current);
      slideTimer.current = null;
    }
  }

  // 卸载时清理挂起的翻页动画回调
  useEffect(() => () => clearSlideTimer(), []);

  function setTransform(dx: number, animated: boolean, ms = 200) {
    const el = areaRef.current?.querySelector<HTMLElement>('[data-swipe-card]');
    if (!el) return;
    el.style.transition = animated ? `transform ${ms}ms ease-out` : 'none';
    el.style.transform = dx === 0 ? '' : `translateX(${dx}px) rotateY(${dx * 0.06}deg)`;
  }

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    clearSlideTimer();
    if ((e.target as Element).closest?.(IGNORE_SELECTOR)) {
      start.current = null; // 交互元素：不接管
      return;
    }
    start.current = { x: t.clientX, y: t.clientY };
    dragging.current = false;
    if (!reducedMotion) setTransform(0, false);
  }

  function onTouchMove(e: React.TouchEvent) {
    if (!start.current) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - start.current.x;
    const dy = t.clientY - start.current.y;
    if (!dragging.current) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * H_RATIO) return;
      dragging.current = true;
    }
    if (!reducedMotion) setTransform(dx, false);
  }

  function onTouchEnd(e: React.TouchEvent) {
    clearSlideTimer();
    const s = start.current;
    if (!s) return;
    start.current = null;
    const t = e.changedTouches[0];
    const dx = t ? t.clientX - s.x : 0;
    const dy = t ? t.clientY - s.y : 0;
    const isSwipe =
      dragging.current && Math.abs(dx) > THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * H_RATIO;
    dragging.current = false;

    if (!isSwipe) {
      if (!reducedMotion) setTransform(0, true);
      return;
    }
    const handled = dx < 0 ? onSwipeLeft() : onSwipeRight();
    if (handled === false || reducedMotion) {
      if (!reducedMotion) setTransform(0, true);
      return;
    }
    // 滑出 → 换内容 → 新卡从对侧滑入
    const out = dx < 0 ? -(window.innerWidth ?? 400) : window.innerWidth ?? 400;
    setTransform(out, true, 250);
    slideTimer.current = window.setTimeout(() => {
      slideTimer.current = null;
      setTransform(dx < 0 ? 60 : -60, false);
      requestAnimationFrame(() => setTransform(0, true, 200));
    }, 250);
  }

  /** 浏览器接管手势（滚动/系统手势）：与"未构成滑动"一致，回弹到中位 */
  function onTouchCancel() {
    start.current = null;
    dragging.current = false;
    if (!reducedMotion) setTransform(0, true);
  }

  return (
    <div
      ref={areaRef}
      data-swipe-area
      className={className}
      /* pan-y：横向手势留给组件，纵向滚动归浏览器 */
      style={{ touchAction: 'pan-y', perspective: '1200px' }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {children}
    </div>
  );
}
