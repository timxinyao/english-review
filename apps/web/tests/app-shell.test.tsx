import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../src/app/shell';

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<AppShell />, { wrapper });
}

describe('AppShell iOS 兼容', () => {
  it('底部导航带 pb-safe（避开 home 指示条）', () => {
    const { container } = renderShell();
    const bottomNav = container.querySelector('nav.fixed');
    expect(bottomNav).not.toBeNull();
    expect(bottomNav!.className).toContain('pb-safe');
    expect(bottomNav!.className).toContain('bottom-0');
  });

  it('主内容区底部留白足够覆盖导航+安全区', () => {
    const { container } = renderShell();
    const main = container.querySelector('main');
    expect(main?.className).toContain('pb-28');
  });
});
