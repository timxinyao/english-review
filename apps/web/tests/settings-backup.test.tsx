import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { RestorePreviewResponse, Settings, AiModelsResponse } from '@el/shared';
import type * as ApiModule from '../src/lib/api';
import { api, ApiError } from '../src/lib/api';
import { BackupSection } from '../src/features/settings/components/BackupSection';

vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const apiMock = vi.mocked(api);

function backupItem(target = 'stable') {
  return {
    id: 'item-1',
    type: 'word',
    target,
    meaning: '稳定的',
    ipa: null,
    source: null,
    sourceUrl: null,
    tags: [],
    notes: null,
    status: 'active',
    queueState: 'started',
    needsReinforcement: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    archivedAt: null,
    examples: [],
    reviewStates: [],
  };
}

function backupJson() {
  return {
    version: '1.2',
    exportedAt: '2026-08-01T10:30:00.000Z',
    settings: { maxNewItemsPerDay: 10, contentLevel: 'B1', preferredTtsVoice: null },
    items: [backupItem()],
    dailyStats: [
      {
        date: '2026-08-01',
        formalTasksCompleted: 5,
        newItemsStarted: 1,
        productionAttempts: 3,
        productionPass: 2,
      },
    ],
  };
}

function makePreview(overrides: Partial<RestorePreviewResponse> = {}): RestorePreviewResponse {
  return {
    previewToken: 'tok-1',
    exportedAt: '2026-08-01T10:30:00.000Z',
    itemCount: 12,
    dailyStatsDays: 30,
    currentItemTotal: 6,
    warnings: ['每日新学额度取值将在恢复后生效'],
    ...overrides,
  };
}

function renderBackupSection(reload: () => void = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<BackupSection reload={reload} />, { wrapper });
}

/** 触发文件选择（jsdom FileReader 异步读文本；等到「校验并预览」可用为止） */
async function selectFile(json: unknown) {
  const input = screen.getByLabelText('备份 JSON 文件');
  const file = new File([typeof json === 'string' ? json : JSON.stringify(json)], 'backup.json', {
    type: 'application/json',
  });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  await waitFor(
    () => expect(screen.getByRole('button', { name: '校验并预览' })).not.toBeDisabled(),
    { timeout: 2000 },
  );
}

/** 走完「选文件 → 校验并预览」并停留在恢复预览（可附带 commit 处理器） */
async function goToPreview(
  preview: RestorePreviewResponse = makePreview(),
  commit?: () => unknown,
): Promise<RequestInit | undefined> {
  const handlers: Record<string, () => unknown> = { '/api/restore/preview': () => preview };
  if (commit) handlers['/api/restore/commit'] = commit;
  apiMock.mockImplementation(((path: string) => {
    const handler = handlers[path];
    if (!handler) return Promise.reject(new Error(`unexpected path: ${path}`));
    return Promise.resolve(handler());
  }) as typeof api);
  await selectFile(backupJson());
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '校验并预览' }));
  });
  await screen.findByRole('heading', { name: '恢复预览' });
  return apiMock.mock.calls.find(([p]) => p === '/api/restore/preview')?.[1];
}

describe('Settings 备份与恢复（PC 显示）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('区块整体 hidden md:block，移动端显示“请在电脑上操作”提示', () => {
    renderBackupSection();
    const section = screen.getByRole('region', { name: '备份与恢复' });
    expect(section.className).toContain('hidden');
    expect(section.className).toContain('md:block');
    expect(screen.getByText('备份与恢复请在电脑上操作。').className).toContain('md:hidden');
  });

  it('导出完整备份：fetch blob 下载，文件名含当天日期', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['{"version":"1.2"}'], { type: 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    let anchor: HTMLAnchorElement | undefined;
    const onDocClick = (e: Event) => {
      anchor = e.target as HTMLAnchorElement;
    };
    document.addEventListener('click', onDocClick);

    renderBackupSection();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '导出完整备份' }));
    });
    document.removeEventListener('click', onDocClick);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/export/backup', { credentials: 'include' });
    expect(anchor).toBeDefined();
    expect(anchor?.download).toBe(
      `english-review-backup-${new Date().toISOString().slice(0, 10)}.json`,
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchor?.download).toBe(
      `english-review-backup-${new Date().toISOString().slice(0, 10)}.json`,
    );
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('导出失败显示错误，不创建下载', async () => {
    const createObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, blob: async () => new Blob([]) }),
    );
    renderBackupSection();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '导出完整备份' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('导出失败');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe('恢复向导', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('步骤 1：非 JSON 文件被拦截并提示，不调用预览接口', async () => {
    renderBackupSection();
    await selectFile('{ not json');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '校验并预览' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('JSON 解析失败');
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/restore/preview')).toHaveLength(0);
  });

  it('步骤 1：schema 校验失败逐条显示（前几条），不调用预览接口', async () => {
    renderBackupSection();
    const doc = {
      ...backupJson(),
      items: [{ ...backupItem(), target: '' }],
    };
    await selectFile(doc);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '校验并预览' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('第 1 项');
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/restore/preview')).toHaveLength(0);
  });

  it('步骤 2：展示备份信息与当前库覆盖警示、warnings', async () => {
    renderBackupSection();
    const init = await goToPreview();

    // 请求体 = 备份 JSON 本身
    expect(JSON.parse(init?.body as string)).toEqual(backupJson());

    expect(screen.getByText('备份时间').closest('div')).toHaveTextContent('2026-08-01 10:30');
    expect(screen.getByText('备份学习项').closest('div')).toHaveTextContent('12 项');
    expect(screen.getByText('统计天数').closest('div')).toHaveTextContent('30 天');
    expect(screen.getByText('当前库学习项').closest('div')).toHaveTextContent('6');
    const warn = screen.getByText('（将被覆盖）');
    expect(warn.className).toContain('text-destructive');
    expect(screen.getByText('每日新学额度取值将在恢复后生效')).toBeVisible();

    const confirm = screen.getByRole('button', { name: '确认覆盖恢复' });
    // destructive 变体已改实心（Task 1 语义变体），标记类随之更新
    expect(confirm.className).toContain('bg-destructive text-accent-foreground');
  });

  it('步骤 3：需二次确认才提交；成功后延迟 reload 并提示刷新中', async () => {
    const reload = vi.fn();
    renderBackupSection(reload);
    await goToPreview(makePreview(), () => ({
      ok: true,
      restoredItems: 12,
      restoredDailyStats: 30,
      snapshotFile: 'snapshot-2026-09-25.json',
    }));

    // 第一次点击：出现覆盖警示，未提交
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认覆盖恢复' }));
    });
    expect(screen.getByText('将覆盖当前全部数据，且已自动创建恢复前快照')).toBeVisible();
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/restore/commit')).toHaveLength(0);

    // 第二次点击：提交 previewToken
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '再次确认覆盖恢复' }));
    });
    expect(
      apiMock.mock.calls
        .filter(([p]) => p === '/api/restore/commit')
        .map(([, init]) => JSON.parse(init?.body as string)),
    ).toEqual([{ previewToken: 'tok-1' }]);

    expect(screen.getByText('恢复完成，正在刷新…')).toBeVisible();
    expect(reload).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('步骤 3：commit 返回 404 提示预览已过期', async () => {
    const reload = vi.fn();
    renderBackupSection(reload);
    await goToPreview(makePreview(), () => {
      throw new ApiError('PREVIEW_EXPIRED', '预览已过期', 404);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认覆盖恢复' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '再次确认覆盖恢复' }));
    });

    expect(await screen.findByText('预览已过期，请重新选择文件')).toBeVisible();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('SettingsPage 集成', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.mockImplementation(((path: string) => {
      if (path === '/api/settings')
        return Promise.resolve({
          maxNewItemsPerDay: 10,
          contentLevel: 'B1',
          preferredTtsVoice: null,
          updatedAt: '2026-09-25T00:00:00.000Z',
        } satisfies Settings);
      if (path === '/api/ai/models')
        return Promise.resolve({
          provider: 'glm',
          models: {
            flash: { model: 'glm-5.3-flash', source: 'auto', inList: true, thinking: 'off' },
            air: { model: 'glm-5.3', source: 'config', inList: true, thinking: 'low' },
            max: { model: 'glm-5.3', source: 'auto', inList: true, thinking: 'off' },
          },
          backgroundConfigured: false,
        thinkingOverride: null,
          taskMapping: [],
          availableModels: ['glm-5.3'],
          checkedAt: '2026-09-25T00:00:00.000Z',
        } satisfies AiModelsResponse);
      throw new Error(`unexpected path: ${path}`);
    }) as typeof api);
  });

  it('Settings 页包含备份与恢复区块与导出按钮', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    const { SettingsPage } = await import('../src/features/settings/SettingsPage');
    render(<SettingsPage />, { wrapper });

    const section = await screen.findByRole('region', { name: '备份与恢复' });
    expect(section.className).toContain('hidden');
    expect(section.className).toContain('md:block');
    expect(within(section).getByRole('button', { name: '导出完整备份' })).toBeVisible();
  });

  it('Settings 页尾有低调的 /tokens 色卡入口（iOS 主屏 PWA 无地址栏）', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    const { SettingsPage } = await import('../src/features/settings/SettingsPage');
    render(<SettingsPage />, { wrapper });

    const link = await screen.findByRole('link', { name: '设计色卡' });
    expect(link).toHaveAttribute('href', '/tokens');
    expect(link.className).toContain('text-muted-foreground'); // 低调小字，非 accent 主链接
  });
});
