import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElapsedTimer } from '../src/components/elapsed-timer';

afterEach(cleanup);

describe('ElapsedTimer', () => {
  it('起始 00:00，每秒递增', async () => {
    vi.useFakeTimers();
    render(<ElapsedTimer since={Date.now()} />);
    expect(screen.getByText('00:00')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText('00:03')).toBeTruthy();
    vi.useRealTimers();
  });

  it('满一小时进位 h:mm:ss', async () => {
    vi.useFakeTimers();
    render(<ElapsedTimer since={Date.now()} />);
    await act(async () => {
      vi.advanceTimersByTime(3_600_000 + 65_000);
    });
    expect(screen.getByText('1:01:05')).toBeTruthy();
    vi.useRealTimers();
  });

  it('卸载清理定时器（无泄漏告警）', () => {
    vi.useFakeTimers();
    const { unmount } = render(<ElapsedTimer since={Date.now()} />);
    unmount();
    expect(() => vi.runAllTimers()).not.toThrow();
    vi.useRealTimers();
  });
});
