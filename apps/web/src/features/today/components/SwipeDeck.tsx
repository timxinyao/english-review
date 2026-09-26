import { useRef, type ReactNode } from 'react';

const THRESHOLD_PX = 60;
/** 水平判定比例：|dx| 必须超过 |dy| 的 1.5 倍 */
const H_RATIO = 1.5;

interface SwipeDeckProps {
  onSwipeLeft: () => boolean | void;
  onSwipeRight: () => boolean | void;
  children: ReactNode;
}

/**
 * 跟手 3D 翻页容器：水平滑动时卡片跟随手指位移 + 轻微 rotateY；
 * 松手超过阈值翻页（先滑出再换内容、新卡从对侧滑入），否则回弹。
 * handler 返回 false = 边界，直接回弹不翻页。
 * prefers-reduced-motion 时跳过所有动画，仅保留手势判定。
 */
export function SwipeDeck({ onSwipeLeft, onSwipeRight, children }: SwipeDeckProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setTransform(dx: number, animated: boolean, ms = 200) {
    const el = cardRef.current;
    if (!el) return;
    el.style.transition = animated ? `transform ${ms}ms ease-out` : 'none';
    el.style.transform = dx === 0 ? '' : `translateX(${dx}px) rotateY(${dx * 0.06}deg)`;
  }

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
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
    window.setTimeout(() => {
      setTransform(dx < 0 ? 60 : -60, false);
      requestAnimationFrame(() => setTransform(0, true, 200));
    }, 250);
  }

  return (
    <div style={{ perspective: '1200px' }}>
      <div
        ref={cardRef}
        data-swipe-deck
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{ willChange: 'transform', backfaceVisibility: 'hidden' }}
      >
        {children}
      </div>
    </div>
  );
}
