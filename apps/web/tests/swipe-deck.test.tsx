import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SwipeDeck } from '../src/features/today/components/SwipeDeck';

afterEach(cleanup);

function deck(): HTMLElement {
  const el = document.querySelector('[data-swipe-deck]');
  if (!(el instanceof HTMLElement)) throw new Error('deck 未渲染');
  return el;
}

function swipeBy(dx: number, dy = 0): void {
  const el = deck();
  fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 200 + dx / 2, clientY: 300 + dy }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
}

describe('SwipeDeck', () => {
  it('渲染 children', () => {
    render(
      <SwipeDeck onSwipeLeft={vi.fn()} onSwipeRight={vi.fn()}>
        <p>卡片内容</p>
      </SwipeDeck>,
    );
    expect(document.querySelector('[data-swipe-deck]')?.textContent).toContain('卡片内容');
  });

  it('左滑超过阈值 → onSwipeLeft 调用一次', () => {
    const left = vi.fn();
    render(
      <SwipeDeck onSwipeLeft={left} onSwipeRight={vi.fn()}>
        <p>卡</p>
      </SwipeDeck>,
    );
    swipeBy(-120);
    expect(left).toHaveBeenCalledTimes(1);
  });

  it('右滑超过阈值 → onSwipeRight 调用一次', () => {
    const right = vi.fn();
    render(
      <SwipeDeck onSwipeLeft={vi.fn()} onSwipeRight={right}>
        <p>卡</p>
      </SwipeDeck>,
    );
    swipeBy(120);
    expect(right).toHaveBeenCalledTimes(1);
  });

  it('位移不足阈值 → 不触发回调', () => {
    const left = vi.fn();
    render(
      <SwipeDeck onSwipeLeft={left} onSwipeRight={vi.fn()}>
        <p>卡</p>
      </SwipeDeck>,
    );
    swipeBy(-40);
    expect(left).not.toHaveBeenCalled();
  });

  it('垂直主导的滑动 → 不触发回调', () => {
    const left = vi.fn();
    render(
      <SwipeDeck onSwipeLeft={left} onSwipeRight={vi.fn()}>
        <p>卡</p>
      </SwipeDeck>,
    );
    fireEvent.touchStart(deck(), { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(deck(), { touches: [{ clientX: 210, clientY: 420 }] });
    fireEvent.touchEnd(deck(), { changedTouches: [{ clientX: 212, clientY: 480 }] });
    expect(left).not.toHaveBeenCalled();
  });

  it('handler 返回 false → 不抛错（边界回弹）', () => {
    const left = vi.fn(() => false);
    render(
      <SwipeDeck onSwipeLeft={left} onSwipeRight={vi.fn()}>
        <p>卡</p>
      </SwipeDeck>,
    );
    expect(() => swipeBy(-120)).not.toThrow();
    expect(left).toHaveBeenCalledTimes(1);
  });
});
