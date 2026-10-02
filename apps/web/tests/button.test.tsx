import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../src/components/ui/button';
import { cn } from '../src/lib/utils';

afterEach(cleanup);

describe('cn 工具', () => {
  it('合并并去重 tailwind 类', () => {
    expect(cn('px-2', 'px-4', 'text-sm')).toBe('px-4 text-sm');
  });
});

describe('Button 基础组件', () => {
  it('渲染默认变体并响应 disabled', () => {
    render(<Button disabled>开始</Button>);
    const btn = screen.getByRole('button', { name: '开始' });
    expect(btn).toBeDisabled();
    expect(btn.className).toContain('bg-accent');
  });

  it('渲染 neutral 变体与自定义类', () => {
    render(
      <Button variant="neutral" className="w-full">
        继续
      </Button>,
    );
    const btn = screen.getByRole('button', { name: '继续' });
    expect(btn.className).toContain('border border-input bg-accent-soft');
    expect(btn.className).toContain('w-full');
  });
});

/** 变体类串是全局按钮颜色唯一出处（spec 2026-10-02），锁死防漂移。
 *  2026-10-02 用户反馈修订：negative/ghost 静止态必须有别于背景的填充，不得透明融入。 */
describe('Button 语义变体类名', () => {
  it.each([
    ['primary', 'bg-accent text-accent-foreground'],
    ['default', 'bg-accent text-accent-foreground'],
    ['neutral', 'border-input bg-accent-soft text-foreground'],
    ['negative', 'border-destructive/50 bg-destructive/10 text-destructive'],
    ['destructive', 'bg-destructive text-white'],
    ['ghost', 'bg-muted text-foreground hover:brightness-95'],
  ] as const)('%s → %s', (variant, expected) => {
    render(<Button variant={variant}>按钮</Button>);
    expect(screen.getByRole('button', { name: '按钮' }).className).toContain(expected);
  });
});
