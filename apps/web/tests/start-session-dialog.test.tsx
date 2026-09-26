import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartSessionDialog } from '../src/features/today/components/StartSessionDialog';

afterEach(cleanup);

describe('StartSessionDialog', () => {
  it('空闲：不渲染', () => {
    render(<StartSessionDialog pending={false} errorMessage={null} onRetry={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('生成中：portal 挂 body，显示等待文案，无按钮', async () => {
    render(<StartSessionDialog pending errorMessage={null} onRetry={vi.fn()} onDismiss={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: '开始今日复习' });
    await waitFor(() => expect(dialog).toBeVisible());
    expect(dialog.parentElement).toBe(document.body);
    expect(withinText(dialog)).toContain('正在准备今日题目');
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('失败：显示错误与重试；重试回调触发', async () => {
    const onRetry = vi.fn();
    render(<StartSessionDialog pending={false} errorMessage="题目正在准备中，请稍候重试" onRetry={onRetry} onDismiss={vi.fn()} />);
    expect(screen.getByText('题目正在准备中，请稍候重试')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

function withinText(el: HTMLElement): string {
  return el.textContent ?? '';
}
