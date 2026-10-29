import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LibraryApi from '../src/features/library/api';
import {
  commitLibraryImport,
  fetchLibraryList,
  libraryKeys,
  previewLibraryImport,
} from '../src/features/library/api';
import { ApiError } from '../src/lib/api';
import { makeListResponse, makePreview, renderLibraryApp } from './library-helpers';

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

const list = vi.mocked(fetchLibraryList);
const preview = vi.mocked(previewLibraryImport);
const commit = vi.mocked(commitLibraryImport);

function candidate(target: string) {
  return {
    type: 'word',
    target,
    meaning: `释义 ${target}`,
    source_example: `Example of ${target}.`,
    extra_examples: [],
    tags: [],
  };
}

const VALID_DOC = { version: '1.2', items: [candidate('alpha'), candidate('beta')] };

async function openWizard() {
  const rendered = renderLibraryApp();
  fireEvent.click(await screen.findByRole('button', { name: '导入' }));
  const textarea = await screen.findByLabelText('粘贴学习库 JSON');
  return { rendered, textarea };
}

async function openPreview() {
  const { rendered, textarea } = await openWizard();
  preview.mockResolvedValue(makePreview());
  fireEvent.change(textarea, { target: { value: JSON.stringify(VALID_DOC) } });
  fireEvent.click(screen.getByRole('button', { name: '预览' }));
  await screen.findByRole('heading', { name: '导入预览' });
  return rendered;
}

describe('ImportWizard 导入向导', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(makeListResponse([]));
  });

  it('非法 JSON 语法直接拦截，不调用预览接口', async () => {
    const { textarea } = await openWizard();
    fireEvent.change(textarea, { target: { value: '{ not valid json' } });
    fireEvent.click(screen.getByRole('button', { name: '预览' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('JSON 解析失败');
    expect(preview).not.toHaveBeenCalled();
  });

  it('schema 校验失败逐条列出：第 N 项 + 字段', async () => {
    const { textarea } = await openWizard();
    const doc = {
      version: '1.2',
      items: [
        candidate('alpha'),
        { type: 'word', meaning: '缺 target', source_example: 'x', extra_examples: [], tags: [] },
      ],
    };
    fireEvent.change(textarea, { target: { value: JSON.stringify(doc) } });
    fireEvent.click(screen.getByRole('button', { name: '预览' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('第 2 项');
    expect(alert).toHaveTextContent('target');
    expect(preview).not.toHaveBeenCalled();
  });

  it('顶层 version 错误提示文件格式问题', async () => {
    const { textarea } = await openWizard();
    fireEvent.change(textarea, {
      target: { value: JSON.stringify({ version: '1.0', items: [candidate('alpha')] }) },
    });
    fireEvent.click(screen.getByRole('button', { name: '预览' }));

    expect(await screen.findByText(/文件格式/)).toBeVisible();
    expect(preview).not.toHaveBeenCalled();
  });

  it('预览行显示建议徽标（title=reason）、来源标记与比对项', async () => {
    await openPreview();

    expect(screen.getByTitle('与已有项释义高度相近').textContent).toBe('合并');
    expect(screen.getByTitle('无相同 target').textContent).toBe('新增');
    expect(screen.getByTitle('内容完全重复').textContent).toBe('跳过');
    expect(screen.getByText(/建议：合并 · AI/)).toBeVisible();
    expect(screen.getByText(/建议：新增 · 规则回退/)).toBeVisible();
    expect(screen.getByText(/建议：跳过 · 规则/)).toBeVisible();
    expect(screen.getByText(/与已有「wear down」比对/)).toBeVisible();
    expect(screen.getByText('It wears you down.')).toBeVisible();
  });

  it('行内下拉可改决定，「全部采用系统建议」恢复建议值', async () => {
    await openPreview();

    const select1 = screen.getByLabelText('决定：第 1 项') as HTMLSelectElement;
    expect(select1.value).toBe('merge');
    fireEvent.change(select1, { target: { value: 'skip_exact_duplicate' } });
    expect(select1.value).toBe('skip_exact_duplicate');

    fireEvent.click(screen.getByRole('button', { name: '全部采用系统建议' }));
    expect(select1.value).toBe('merge');
  });

  it('导入预览显示原句译文，便于确认补译文内容', async () => {
    const { textarea } = await openWizard();
    const fixture = makePreview();
    fixture.items[0]!.candidate.source_example_translation = '这会让你精疲力尽。';
    preview.mockResolvedValue(fixture);
    fireEvent.change(textarea, { target: { value: JSON.stringify(VALID_DOC) } });
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(await screen.findByText('这会让你精疲力尽。')).toBeVisible();
  });

  it('提交带回用户决定，成功后显示摘要并 invalidate library query', async () => {
    const { queryClient } = await openPreview();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    fireEvent.change(screen.getByLabelText('决定：第 1 项'), { target: { value: 'new_item' } });
    commit.mockResolvedValue({ created: 2, merged: 0, skipped: 1, total: 3 });

    fireEvent.click(screen.getByRole('button', { name: /确认导入/ }));
    expect(await screen.findByRole('heading', { name: '导入完成' })).toBeVisible();
    expect(screen.getByText(/新增 2/)).toBeVisible();
    expect(screen.getByText(/合并 0/)).toBeVisible();
    expect(screen.getByText(/跳过 1/)).toBeVisible();
    expect(commit.mock.calls[0]?.[0]).toEqual({
      previewToken: 'tok-1',
      decisions: [
        { index: 0, action: 'new_item' },
        { index: 1, action: 'new_item' },
        { index: 2, action: 'skip_exact_duplicate' },
      ],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: libraryKeys.all });

    fireEvent.click(screen.getByRole('button', { name: '返回 Library 列表' }));
    expect(
      await screen.findByText('还没有学习项。可由教练帮你导入，或在电脑上打开本页使用导入。'),
    ).toBeVisible();
  });

  it('commit 404（token 过期）提示重新预览', async () => {
    await openPreview();
    commit.mockRejectedValue(new ApiError('NOT_FOUND', '预览不存在', 404));

    fireEvent.click(screen.getByRole('button', { name: /确认导入/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('重新预览');
    expect(screen.queryByRole('heading', { name: '导入完成' })).toBeNull();
  });

  it('V2 goal conflict is visible and requires the user to acknowledge before commit', async () => {
    const { textarea } = await openWizard();
    const fixture = makePreview();
    fixture.items[0]!.productionGoalChange = { from: null, to: false };
    preview.mockResolvedValue(fixture);
    fireEvent.change(textarea, {
      target: { value: JSON.stringify({ version: '2.0', items: [candidate('alpha')] }) },
    });
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    await screen.findByRole('heading', { name: '导入预览' });
    expect(screen.getByText(/按类型默认.*不需要造句/)).toBeVisible();
    expect(screen.getByRole('button', { name: /确认导入/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /确认第 1 项造句目标变化/ }));
    expect(screen.getByRole('button', { name: /确认导入/ })).toBeEnabled();
  });
});
