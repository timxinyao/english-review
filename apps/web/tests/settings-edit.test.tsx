import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiModelsResponse, Settings } from '@el/shared';

const patchCalls: Array<{ path: string; body: unknown }> = [];

vi.mock('../src/lib/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/settings' && !init?.method) {
      return {
        maxNewItemsPerDay: 10,
        todayReviewLimit: 15,
        contentLevel: 'B1',
        preferredTtsVoice: null,
        updatedAt: '2026-09-25T00:00:00.000Z',
      } satisfies Settings;
    }
    if (path === '/api/settings' && init?.method === 'PATCH') {
      patchCalls.push({ path, body: JSON.parse(String(init.body)) });
      const patch = JSON.parse(String(init.body)) as Partial<Settings>;
      return {
        maxNewItemsPerDay: 10,
        todayReviewLimit: 15,
        contentLevel: 'B1',
        preferredTtsVoice: null,
        updatedAt: '2026-09-25T00:00:00.000Z',
        ...patch,
      } satisfies Settings;
    }
    if (path === '/api/ai/models') {
      return {
        provider: 'glm',
        models: {
          flash: { model: 'glm-5.3-flash', source: 'auto', inList: true, thinking: 'off' },
          air: { model: 'glm-5.3', source: 'auto', inList: true, thinking: 'off' },
          max: { model: 'glm-5.3', source: 'auto', inList: true, thinking: 'medium' },
        },
        backgroundConfigured: false,
        thinkingOverride: null,
        taskMapping: [
          {
            task: 'generateUnderstandingQuestions',
            alias: 'flash',
            model: 'glm-5.3-flash',
            thinking: 'off',
            provider: 'main',
          },
        ],
        availableModels: [],
        checkedAt: null,
      } satisfies AiModelsResponse;
    }
    throw new Error(`unexpected: ${path} ${init?.method ?? 'GET'}`);
  }),
}));

const { SettingsPage } = await import('../src/features/settings/SettingsPage');

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<SettingsPage />, { wrapper });
}

afterEach(() => {
  cleanup();
  patchCalls.length = 0;
});

describe('Settings 编辑（每日额度与内容难度）', () => {
  it('额度下拉含 5/10/15/20/不限制，选择后 PATCH 保存并提示', async () => {
    renderPage();
    const select = await screen.findByLabelText('每日新学习项上限');
    expect(select).toHaveValue('10');
    await userEvent.selectOptions(select, '20');
    expect(patchCalls).toEqual([{ path: '/api/settings', body: { maxNewItemsPerDay: 20 } }]);
    expect(await screen.findByText('已保存')).toBeVisible();
  });

  it('内容难度切换 PATCH contentLevel', async () => {
    renderPage();
    const select = await screen.findByLabelText('内容难度');
    await userEvent.selectOptions(select, 'B2');
    expect(patchCalls.at(-1)?.body).toEqual({ contentLevel: 'B2' });
  });

  it('今日复习上限下拉（10/15/20/30/不限制，默认 15）选择后 PATCH todayReviewLimit', async () => {
    renderPage();
    const select = await screen.findByLabelText('今日复习上限');
    expect(select).toHaveValue('15');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['10', '15', '20', '30', '-1']);
    await userEvent.selectOptions(select, '30');
    expect(patchCalls).toEqual([{ path: '/api/settings', body: { todayReviewLimit: 30 } }]);
    expect(await screen.findByText('已保存')).toBeVisible();
  });

  it('说明文案注明两个上限各自的语义', async () => {
    renderPage();
    expect(
      await screen.findByText(/新学上限限制每天从 New Queue 引入的新词/),
    ).toBeVisible();
    expect(await screen.findByText(/今日复习上限限制开始复习时一次入队的到期复习题/)).toBeVisible();
  });
});
