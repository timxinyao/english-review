import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/components/ui/button';
import { cn } from '../src/lib/utils';

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

  it('渲染 outline 变体与自定义类', () => {
    render(
      <Button variant="outline" className="w-full">
        继续
      </Button>,
    );
    const btn = screen.getByRole('button', { name: '继续' });
    expect(btn.className).toContain('border');
    expect(btn.className).toContain('w-full');
  });
});
