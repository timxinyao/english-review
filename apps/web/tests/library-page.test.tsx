import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LibraryApi from '../src/features/library/api';
import {
  LIBRARY_PAGE_SIZE,
  fetchLibraryDetail,
  fetchLibraryList,
} from '../src/features/library/api';
import { makeDetail, makeListItem, makeListResponse, renderLibraryApp } from './library-helpers';

// vitest 未开 globals，@testing-library/react 不会自动 cleanup
afterEach(cleanup);

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

const list = vi.mocked(fetchLibraryList);

describe('LibraryPage 列表', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(makeListResponse([]));
  });

  it('渲染行数据：target/meaning/两维阶段/source/tags', async () => {
    list.mockResolvedValue(
      makeListResponse([
        makeListItem(),
        makeListItem({
          id: 'item-2',
          type: 'chunk',
          target: 'wear down',
          meaning: '逐渐使……疲惫',
          tags: [],
          source: null,
          status: 'paused',
          queueState: 'new',
          understandingStage: '未开始',
          productionStage: '未开始',
          nextReviewAt: null,
        }),
      ]),
    );
    renderLibraryApp();

    expect(await screen.findByText('resilient')).toBeVisible();
    expect(screen.getByText('有韧性的；能快速恢复的')).toBeVisible();
    expect(screen.getByText('Avatar')).toBeVisible();
    expect(screen.getByText('Avatar S01E12')).toBeVisible();
    expect(screen.getByText('理解 练习中')).toBeVisible();
    expect(screen.getByText('输出 初学')).toBeVisible();
    expect(screen.getByText('wear down')).toBeVisible();
    expect(screen.getByText('理解 未开始')).toBeVisible();
  });

  it('搜索输入防抖 300ms 后才带 query 参数调用接口', async () => {
    vi.useFakeTimers();
    try {
      renderLibraryApp();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      list.mockClear();

      fireEvent.change(screen.getByLabelText('搜索学习项'), { target: { value: 'wear' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(list).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ query: 'wear', page: 1 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('筛选 chips：Word 带类型参数、学习中带 status=active', async () => {
    renderLibraryApp();
    await screen.findByText('还没有学习项，点击导入开始');

    fireEvent.click(screen.getByRole('button', { name: 'Word' }));
    await waitFor(() => {
      expect(list.mock.lastCall?.[0]).toMatchObject({ type: 'word' });
    });

    fireEvent.click(screen.getByRole('button', { name: '学习中' }));
    await waitFor(() => {
      expect(list.mock.lastCall?.[0]).toEqual({
        page: 1,
        pageSize: LIBRARY_PAGE_SIZE,
        status: 'active',
      });
    });
  });

  it('分页：显示页码信息并翻页', async () => {
    const pageOne = Array.from({ length: LIBRARY_PAGE_SIZE }, (_, i) =>
      makeListItem({ id: `i${i}`, target: `word-${i}` }),
    );
    list.mockResolvedValueOnce(makeListResponse(pageOne, 120, 1, LIBRARY_PAGE_SIZE));
    list.mockResolvedValue(
      makeListResponse(
        [makeListItem({ id: 'p2', target: 'page-two-item' })],
        25,
        2,
        LIBRARY_PAGE_SIZE,
      ),
    );
    renderLibraryApp();

    expect(await screen.findByText('word-0')).toBeVisible();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    const totalPages = Math.ceil(120 / LIBRARY_PAGE_SIZE);
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === `第 1 / ${totalPages} 页 · 共 120 项`,
      ),
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(list.mock.lastCall?.[0]).toMatchObject({ page: 2 });
    });
    expect(await screen.findByText('page-two-item')).toBeVisible();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === '第 2 / 2 页 · 共 25 项',
      ),
    ).toBeVisible();
  });

  it('空态显示安静文案与导入入口', async () => {
    renderLibraryApp();
    expect(await screen.findByText('还没有学习项，点击导入开始')).toBeVisible();
    expect(screen.getByRole('button', { name: '开始导入' })).toBeVisible();
  });

  it('点击行进入详情路由', async () => {
    list.mockResolvedValue(makeListResponse([makeListItem()]));
    vi.mocked(fetchLibraryDetail).mockResolvedValue(makeDetail());
    renderLibraryApp();

    fireEvent.click(await screen.findByRole('link', { name: /resilient/ }));
    expect(await screen.findByRole('heading', { name: 'resilient' })).toBeVisible();
  });

  it('点击导入进入导入向导视图', async () => {
    renderLibraryApp();
    await screen.findByText('还没有学习项，点击导入开始');

    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    expect(await screen.findByLabelText('粘贴学习库 JSON')).toBeVisible();
  });
});
