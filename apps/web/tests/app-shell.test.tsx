import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/app/shell';

afterEach(cleanup);

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(<AppShell />, { wrapper }), client };
}

describe('AppShell iOS 兼容', () => {
  it('底部导航带 pb-safe（避开 home 指示条）', () => {
    const { container } = renderShell();
    const bottomNav = container.querySelector('nav.fixed');
    expect(bottomNav).not.toBeNull();
    expect(bottomNav!.className).toContain('pb-safe');
    expect(bottomNav!.className).toContain('bottom-0');
  });

  it('主内容区底部大留白（iOS 惯例）+ 顶栏安全区呼吸留白', () => {
    const { container } = renderShell();
    const main = container.querySelector('main');
    const header = container.querySelector('header');
    expect(main?.className).toContain('pb-40');
    expect(header?.className).toContain('pt-safe-lg');
  });

  it('顶栏有刷新按钮，点击刷新全部查询数据（不打断当前会话）', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    render(<AppShell />, { wrapper });
    await userEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(spy).toHaveBeenCalledOnce();
  });
});
