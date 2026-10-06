import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
          air: { model: 'glm-5.3', source: 'auto', inList: true, thinking: 'off' },
          max: { model: 'glm-5.3', source: 'auto', inList: true, thinking: 'medium' },
        },
        backgroundConfigured: false,
        thinkingOverride: null,
        // 2026-09-25 基准矩阵：生成全 flash/off；批改 max/medium；judge flash/low；cloze flash/off
        taskMapping: [
          {
            task: 'generateUnderstandingQuestions',
            alias: 'flash',
            model: 'glm-5.3-flash',
            thinking: 'off',
            provider: 'background',
          },
          {
            task: 'generateClozeQuestions',
            alias: 'flash',
            model: 'glm-5.3-flash',
            thinking: 'off',
            provider: 'background',
          },
          { task: 'checkCloze', alias: 'flash', model: 'glm-5.3-flash', thinking: 'off', provider: 'main' },
          {
            task: 'generateProductionPrompt',
            alias: 'flash',
            model: 'glm-5.3-flash',
            thinking: 'off',
            provider: 'background',
          },
          { task: 'checkProduction', alias: 'max', model: 'glm-5.3', thinking: 'medium', provider: 'main' },
          { task: 'generateRead', alias: 'flash', model: 'glm-5.3-flash', thinking: 'off', provider: 'main' },
          {
            task: 'judgeDuplicateMeaning',
            alias: 'flash',
            model: 'glm-5.3-flash',
            thinking: 'low',
            provider: 'background',
          },
        ],
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

afterEach(() => cleanup());

describe('Settings 页 AI 模型区块（按任务矩阵动态分组）', () => {
  it('生成类任务合并为一行：flash + 思考关', async () => {
    renderPage();
    expect(
      await screen.findByText('理解题生成 · 填空题生成 · 填空兜底判定 · 表达题生成 · Read 生成'),
    ).toBeVisible();
  });

  it('表达批改单独一行：主模型 + 思考中（2026-09-25 基准矩阵）', async () => {
    renderPage();
    expect(await screen.findByText('表达批改', { exact: false })).toBeVisible();
    expect(screen.getAllByText('glm-5.3').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('思考 中')).toBeVisible();
  });

  it('导入重复判定：flash + 思考低', async () => {
    renderPage();
    expect(await screen.findByText('导入重复判定')).toBeVisible();
    expect(screen.getByText('思考 低')).toBeVisible();
  });

  it('有可用清单时展示自动选择说明', async () => {
    renderPage();
    expect(await screen.findByText(/自动从 2 个可用模型中选择最新版本/)).toBeVisible();
  });
});
