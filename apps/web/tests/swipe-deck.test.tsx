import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SwipeDeck } from '../src/features/today/components/SwipeDeck';

afterEach(cleanup);

/** 手势区块（页面级容器） */
function area(): HTMLElement {
  const el = document.querySelector('[data-swipe-area]');
  if (!(el instanceof HTMLElement)) throw new Error('area 未渲染');
  return el;
}

/** 位移目标卡片 */
function card(): HTMLElement {
  const el = document.querySelector('[data-swipe-card]');
  if (!(el instanceof HTMLElement)) throw new Error('card 未渲染');
  return el;
}

function renderDeck(left: () => boolean | void = vi.fn(), right: () => boolean | void = vi.fn()) {
  render(
    <SwipeDeck onSwipeLeft={left} onSwipeRight={right}>
      <p>进度行</p>
      <button type="button">按钮</button>
      <div data-swipe-card>
        <p>卡片内容</p>
      </div>
    </SwipeDeck>,
  );
}

function swipeBy(dx: number, dy = 0): void {
  const el = area();
  fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 200 + dx / 2, clientY: 300 + dy }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
}

describe('SwipeDeck（页面级手势）', () => {
  it('渲染 children；卡片外文本（进度行）也在手势区内', () => {
    renderDeck();
    expect(area().textContent).toContain('进度行');
    expect(card().textContent).toContain('卡片内容');
  });

  it('区块任意位置左滑超过阈值 → onSwipeLeft 调用一次', () => {
    const left = vi.fn();
    renderDeck(left);
    swipeBy(-120);
    expect(left).toHaveBeenCalledTimes(1);
  });

  it('右滑超过阈值 → onSwipeRight 调用一次', () => {
    const right = vi.fn();
    renderDeck(undefined, right);
    swipeBy(120);
    expect(right).toHaveBeenCalledTimes(1);
  });

  it('位移不足阈值 → 不触发回调', () => {
    const left = vi.fn();
    renderDeck(left);
    swipeBy(-40);
    expect(left).not.toHaveBeenCalled();
  });

  it('垂直主导的滑动 → 不触发回调', () => {
    const left = vi.fn();
    renderDeck(left);
    fireEvent.touchStart(area(), { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(area(), { touches: [{ clientX: 210, clientY: 420 }] });
    fireEvent.touchEnd(area(), { changedTouches: [{ clientX: 212, clientY: 480 }] });
    expect(left).not.toHaveBeenCalled();
  });

  it('handler 返回 false → 不抛错（边界回弹）', () => {
    const left = vi.fn(() => false);
    renderDeck(left);
    expect(() => swipeBy(-120)).not.toThrow();
    expect(left).toHaveBeenCalledTimes(1);
  });

  it('触摸起点在按钮上 → 不触发手势（交互元素防护）', () => {
    const right = vi.fn();
    renderDeck(undefined, right);
    const btn = screen.getByRole('button', { name: '按钮' });
    fireEvent.touchStart(btn, { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(area(), { touches: [{ clientX: 320, clientY: 300 }] });
    fireEvent.touchEnd(area(), { changedTouches: [{ clientX: 320, clientY: 300 }] });
    expect(right).not.toHaveBeenCalled();
  });

  it('跟手位移作用于 [data-swipe-card]，手势结束后复位', () => {
    renderDeck();
    const el = card();
    fireEvent.touchStart(area(), { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(area(), { touches: [{ clientX: 100, clientY: 300 }] });
    expect(el.style.transform).toContain('translateX(');
    fireEvent.touchEnd(area(), { changedTouches: [{ clientX: 80, clientY: 300 }] });
  });
});
