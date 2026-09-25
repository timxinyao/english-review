import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AiModelsResponse, Settings } from '@el/shared';

vi.mock('../src/lib/api', () => ({
  api: vi.fn(async (path: string) => {
    if (path === '/api/settings') {
      return {
        maxNewItemsPerDay: 10,
        contentLevel: 'B1',
        preferredTtsVoice: null,
        updatedAt: '2026-09-25T00:00:00.000Z',
      } satisfies Settings;
    }
    if (path === '/api/ai/models') {
      return {
        provider: 'glm',
        models: {
          flash: { model: 'glm-5.3-flash', source: 'auto', inList: true, thinking: 'off' },
          air: { model: 'glm-5.3', source: 'config', inList: true, thinking: 'low' },
          max: { model: 'glm-5.3', source: 'auto', inList: true, thinking: 'off' },
        },
        thinkingOverride: null,
        taskMapping: [],
        availableModels: ['glm-5.3', 'glm-5.3-flash'],
        checkedAt: '2026-09-25T00:00:00.000Z',
      } satisfies AiModelsResponse;
    }
    throw new Error(`unexpected path: ${path}`);
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

describe('Settings 页 AI 模型区块', () => {
  it('展示各用途模型名与来源徽标', async () => {
    renderPage();
    expect(await screen.findByText('glm-5.3-flash')).toBeVisible();
    expect(screen.getByText('glm-5.3', { exact: true })).toBeVisible();
    expect(screen.getByText('自动选择')).toBeVisible();
    expect(screen.getByText('配置指定')).toBeVisible();
    expect(screen.getByText('题目生成')).toBeVisible();
    expect(screen.getByText('判定与批改')).toBeVisible();
  });

  it('展示思考强度徽标', async () => {
    renderPage();
    expect(await screen.findByText('思考 关')).toBeVisible();
    expect(screen.getByText('思考 低')).toBeVisible();
  });

  it('有可用清单时展示自动选择说明', async () => {
    renderPage();
    expect(await screen.findByText(/自动从 2 个可用模型中选择最新版本/)).toBeVisible();
  });
});
