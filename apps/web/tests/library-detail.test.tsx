import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LibraryApi from '../src/features/library/api';
import {
  archiveLibraryItem,
  fetchLibraryDetail,
  masterLibraryItem,
  pauseLibraryItem,
  resetLibraryItemProgress,
  restoreLibraryItem,
  resumeLibraryItem,
  updateLibraryItem,
} from '../src/features/library/api';
import { makeDetail, makeUpdateResponse, renderLibraryApp } from './library-helpers';

vi.mock('../src/features/library/api', async (importOriginal) => {
  const actual = await importOriginal<typeof LibraryApi>();
  return {
    ...actual,
    fetchLibraryList: vi.fn(),
    fetchLibraryDetail: vi.fn(),
    updateLibraryItem: vi.fn(),
    pauseLibraryItem: vi.fn(),
    resumeLibraryItem: vi.fn(),
    archiveLibraryItem: vi.fn(),
    restoreLibraryItem: vi.fn(),
    resetLibraryItemProgress: vi.fn(),
    masterLibraryItem: vi.fn(),
    previewLibraryImport: vi.fn(),
    commitLibraryImport: vi.fn(),
  };
});

// vitest 未开 globals，@testing-library/react 不会自动 cleanup
afterEach(cleanup);

const detailApi = vi.mocked(fetchLibraryDetail);
const update = vi.mocked(updateLibraryItem);
const pause = vi.mocked(pauseLibraryItem);
const resume = vi.mocked(resumeLibraryItem);
const archive = vi.mocked(archiveLibraryItem);
const restore = vi.mocked(restoreLibraryItem);
const resetProgress = vi.mocked(resetLibraryItemProgress);
const master = vi.mocked(masterLibraryItem);

function renderDetail(overrides = {}) {
  const detail = makeDetail(overrides);
  detailApi.mockResolvedValue(detail);
  renderLibraryApp(`/library/${detail.item.id}`);
  return detail;
}

async function openEditForm() {
  fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
  await screen.findByDisplayValue('resilient');
}

describe('LibraryDetail 详情', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    update.mockResolvedValue(makeUpdateResponse(makeDetail(), false));
    [pause, resume, archive, restore, resetProgress, master].forEach((fn) =>
      fn.mockResolvedValue(makeDetail()),
    );
  });

  it('渲染详情：target/ipa/meaning/来源/链接/tags/notes 与三组例句', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'resilient' })).toBeVisible();
    expect(screen.getByText('/rɪˈzɪliənt/')).toBeVisible();
    expect(screen.getByText('有韧性的')).toBeVisible();
    expect(screen.getByText('Avatar S01E12')).toBeVisible();
    expect(screen.getByRole('link', { name: 'https://example.com/s01e12' })).toHaveAttribute(
      'href',
      'https://example.com/s01e12',
    );
    expect(screen.getByText('Avatar')).toBeVisible();
    expect(screen.getByText('adj')).toBeVisible();
    expect(screen.getByText('常用于描述系统或人的韧性。')).toBeVisible();

    expect(screen.getByText('The city proved resilient after the storm.')).toBeVisible();
    expect(screen.getByText('She is resilient under pressure.')).toBeVisible();
    expect(screen.getByText('I stayed resilient during the exam week.')).toBeVisible();
    expect(screen.getByText('A resilient mindset helps.')).toBeVisible();
  });

  it('渲染两维状态：stability 天数、阶段与下次复习时间', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'resilient' });

    expect(screen.getByText('理解')).toBeVisible();
    expect(screen.getByText('输出')).toBeVisible();
    expect(screen.getByText('S45天')).toBeVisible();
    expect(screen.getByText('熟练')).toBeVisible();
    expect(screen.getByText('—')).toBeVisible();
    expect(screen.getByText('未开始')).toBeVisible();
    expect(screen.getByText('2026-09-25')).toBeVisible();
    expect(screen.getByText('未安排')).toBeVisible();
  });

  it('personal 例句 pin 星标与取消收藏按钮：点击后提交 pinned=false', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'resilient' });

    fireEvent.click(screen.getByRole('button', { name: '取消收藏' }));
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({
          personalExamples: expect.arrayContaining([
            expect.objectContaining({ id: 'pe-1', pinned: false }),
          ]),
        }),
      );
    });
  });

  it('编辑表单回填所有字段（word 显示 IPA）', async () => {
    renderDetail();
    await openEditForm();

    expect(screen.getByDisplayValue('resilient')).toBeVisible();
    expect(screen.getByDisplayValue('有韧性的')).toBeVisible();
    expect(screen.getByDisplayValue('/rɪˈzɪliənt/')).toBeVisible();
    expect(screen.getByDisplayValue('Avatar S01E12')).toBeVisible();
    expect(screen.getByDisplayValue('https://example.com/s01e12')).toBeVisible();
    expect(screen.getByDisplayValue('Avatar, adj')).toBeVisible();
    expect(screen.getByDisplayValue('常用于描述系统或人的韧性。')).toBeVisible();
    expect(screen.getByDisplayValue('The city proved resilient after the storm.')).toBeVisible();
    expect(screen.getByDisplayValue('She is resilient under pressure.')).toBeVisible();
    expect(screen.getByDisplayValue('I stayed resilient during the exam week.')).toBeVisible();
    expect(screen.getByLabelText('IPA')).toBeVisible();
  });

  it('chunk 编辑表单不显示 IPA 字段', async () => {
    renderDetail({ type: 'chunk', ipa: null });
    await openEditForm();
    expect(screen.queryByLabelText('IPA')).toBeNull();
  });

  it('造句目标三态可回填并随编辑提交', async () => {
    renderDetail({ productionEnabledOverride: null });
    await openEditForm();
    const goal = screen.getByLabelText('造句目标') as HTMLSelectElement;
    expect(goal.value).toBe('default');
    fireEvent.change(goal, { target: { value: 'enabled' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({ productionEnabledOverride: true }),
      ),
    );

    cleanup();
    renderDetail({ productionEnabledOverride: false });
    await openEditForm();
    expect((screen.getByLabelText('造句目标') as HTMLSelectElement).value).toBe('disabled');
    fireEvent.change(screen.getByLabelText('造句目标'), { target: { value: 'default' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith(
        'item-1',
        expect.objectContaining({ productionEnabledOverride: null }),
      ),
    );
  });

  it('保存提交完整 payload：tags 拆分、空补充例句过滤、personal 带 pin', async () => {
    renderDetail();
    await openEditForm();

    fireEvent.change(screen.getByDisplayValue('Avatar, adj'), {
      target: { value: 'Avatar, 影视, ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加例句' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        'item-1',
        expect.objectContaining({
          target: 'resilient',
          meaning: '有韧性的',
          ipa: '/rɪˈzɪliənt/',
          tags: ['Avatar', '影视'],
          extraExamples: ['She is resilient under pressure.'],
          personalExamples: [
            { id: 'pe-1', text: 'I stayed resilient during the exam week.', pinned: true },
            { id: 'pe-2', text: 'A resilient mindset helps.', pinned: false },
          ],
        }),
      );
    });
  });

  it('保存后 progressResetSuggested=true 弹确认，确定后调用 reset', async () => {
    update.mockResolvedValue(makeUpdateResponse(makeDetail(), true));
    renderDetail();
    await openEditForm();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('释义已变化，是否重置学习进度？');

    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(resetProgress).toHaveBeenCalledWith('item-1');
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('保存后无重置建议则不弹确认并退出编辑', async () => {
    renderDetail();
    await openEditForm();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(update).toHaveBeenCalled();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('button', { name: '编辑' })).toBeVisible();
  });

  it('显式操作：暂停/归档(destructive)/标记已掌握；重置进度带确认', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'resilient' });

    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    await waitFor(() => {
      expect(pause).toHaveBeenCalledWith('item-1');
    });

    const archiveBtn = screen.getByRole('button', { name: '归档' });
    // destructive 变体已改实心（Task 1 语义变体），标记类随之更新
    expect(archiveBtn.className).toContain('bg-destructive text-accent-foreground');
    fireEvent.click(archiveBtn);
    await waitFor(() => {
      expect(archive).toHaveBeenCalledWith('item-1');
    });

    fireEvent.click(screen.getByRole('button', { name: '标记已掌握' }));
    await waitFor(() => {
      expect(master).toHaveBeenCalledWith('item-1');
    });

    fireEvent.click(screen.getByRole('button', { name: '重置进度' }));
    expect(resetProgress).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(resetProgress).toHaveBeenCalledWith('item-1');
    });
  });

  it('paused 显示恢复（resume），archived 显示恢复（restore）且非 destructive', async () => {
    renderDetail({ status: 'paused' });
    await screen.findByRole('heading', { name: 'resilient' });
    expect(screen.queryByRole('button', { name: '暂停' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => {
      expect(resume).toHaveBeenCalledWith('item-1');
    });

    cleanup();
    renderDetail({ status: 'archived' });
    await screen.findByRole('heading', { name: 'resilient' });
    const restoreBtn = screen.getByRole('button', { name: '恢复' });
    expect(restoreBtn.className).not.toContain('text-destructive');
    fireEvent.click(restoreBtn);
    await waitFor(() => {
      expect(restore).toHaveBeenCalledWith('item-1');
    });
  });
});
