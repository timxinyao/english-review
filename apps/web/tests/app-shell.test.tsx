import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/app/shell';

const keyboard = { inset: 0, open: false, anchored: false, visibleHeight: 812, offsetTop: 0 };
vi.mock('../src/lib/keyboard-inset', () => ({
  useKeyboardInset: () => keyboard.inset,
  useKeyboardViewport: () => keyboard,
  useKeyboardPhase: () => (keyboard.open ? 'open' : keyboard.anchored ? 'focused' : 'idle'),
}));

afterEach(() => {
  cleanup();
  keyboard.open = false;
  keyboard.anchored = false;
});

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(<AppShell />, { wrapper }), client };
}

function renderShellAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(<AppShell />, { wrapper }), client };
}

describe('AppShell iOS 兼容', () => {
  it('底部导航带 pb-safe（避开 home 指示条）', () => {
    const { container } = renderShell();
    const bottomNav = container.querySelector('nav.fixed');
    expect(bottomNav).not.toBeNull();
    expect(bottomNav!.className).toContain('pb-safe-tight');
    expect(bottomNav!.className).toContain('bottom-0');
  });

  it('顶栏为 fixed 且未被 relative 覆盖（CSS 级联陷阱回归）', () => {
    const { container } = renderShell();
    const header = container.querySelector('header');
    expect(header?.className).toContain('fixed');
    expect(header?.className).not.toContain('relative');
  });

  it('主内容区底部大留白仅限非 Today 页；顶栏只留安全区、导航用收紧避让（用户偏好更贴边）', () => {
    const { container } = renderShellAt('/library');
    const main = container.querySelector('main');
    const header = container.querySelector('header');
    const nav = container.querySelector('nav.fixed');
    expect(main?.className).toContain('pb-40');
    expect(header?.className).toContain('pt-safe');
    expect(nav?.className).toContain('pb-safe-tight');
  });

  it('Today 路由：主内容区不留 pb-40 大留白（沉浸式卡自身贴底部导航，§5.1 一题一屏）', () => {
    const { container } = renderShellAt('/today');
    const main = container.querySelector('main');
    expect(main?.className).not.toContain('pb-40');
    expect(main?.className).toContain('max-w-[900px]');
  });

  it('Today 键盘期锚定整页顶部、隐藏底部导航，Library 不受影响', () => {
    keyboard.open = true;
    keyboard.anchored = true;
    const { container } = renderShellAt('/today');
    expect(container.querySelector('[data-keyboard-anchored]')).not.toBeNull();
    expect(container.querySelector('nav.fixed')?.classList.contains('hidden')).toBe(true);
    cleanup();

    const library = renderShellAt('/library');
    expect(library.container.querySelector('[data-keyboard-anchored]')).toBeNull();
    expect(library.container.querySelector('nav.fixed')?.classList.contains('hidden')).toBe(false);
  });

  it('顶栏有刷新按钮，点击整页刷新（location.reload）', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    render(<AppShell />, { wrapper });
    await userEvent.click(screen.getByRole('button', { name: '刷新' }));
    await new Promise((r) => setTimeout(r, 400)); // onRefresh 内 300ms 延迟后 reload
    expect(reloadSpy).toHaveBeenCalledOnce();
  });
});
