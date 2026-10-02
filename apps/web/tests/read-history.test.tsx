import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HISTORY_URL,
  RECENT_URL,
  apiCalls,
  makeHistoryItem,
  makeHistoryResponse,
  makeLegacyArticle,
  renderReadApp,
  stubApi,
} from './read-helpers';

// vitest 未开 globals，@testing-library/react 不会自动 cleanup
afterEach(cleanup);

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const READ_HISTORY_PAGE_SIZE = 20;

describe('Read History（历史视图）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi({ [RECENT_URL]: makeHistoryResponse([]) });
  });

  it('从首页进入：分页列表渲染（标题/类型/词数/星标），翻页带 page=2', async () => {
    const pageOne = Array.from({ length: READ_HISTORY_PAGE_SIZE }, (_, i) =>
      makeHistoryItem({ id: `a${i}`, title: `article-${i}` }),
    );
    stubApi({
      [RECENT_URL]: makeHistoryResponse([]),
      [HISTORY_URL]: makeHistoryResponse(pageOne, 25, 1, READ_HISTORY_PAGE_SIZE),
      '/api/read/history?page=2&pageSize=20&favorite=all': makeHistoryResponse(
        [makeHistoryItem({ id: 'p2', title: 'page-two-item', favorite: true })],
        25,
        2,
        READ_HISTORY_PAGE_SIZE,
      ),
    });
    renderReadApp();

    fireEvent.click(await screen.findByRole('button', { name: '查看全部历史' }));

    expect(await screen.findByText('article-0')).toBeVisible();
    expect(screen.getByText('article-19')).toBeVisible();
    expect(screen.getAllByText('260 词').length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === '第 1 / 2 页 · 共 25 篇',
      ),
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(apiCalls('/api/read/history?page=2').length).toBe(1);
    });
    expect(await screen.findByText('page-two-item')).toBeVisible();
    // 收藏项带星标图标
    expect(
      screen.getByRole('button', { name: /page-two-item/ }).querySelector('svg'),
    ).not.toBeNull();
  });

  it('筛选 chips：默认全部；点“收藏”后请求 favorite=true', async () => {
    stubApi({
      [RECENT_URL]: makeHistoryResponse([]),
      [HISTORY_URL]: makeHistoryResponse([]),
      '/api/read/history?page=1&pageSize=20&favorite=true': makeHistoryResponse([
        makeHistoryItem({ favorite: true }),
      ]),
    });
    renderReadApp();

    fireEvent.click(await screen.findByRole('button', { name: '查看全部历史' }));
    expect(await screen.findByRole('button', { name: '收藏' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    expect(screen.getByRole('button', { name: '收藏' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(apiCalls('/api/read/history?page=1&pageSize=20&favorite=true').length).toBe(1);
    });
    expect(await screen.findByText('A Quiet Morning')).toBeVisible();
  });

  it('列表项点击加载文章详情（GET /api/read/:id），遗留检查题只读，返回历史视图', async () => {
    stubApi({
      [RECENT_URL]: makeHistoryResponse([]),
      [HISTORY_URL]: makeHistoryResponse([makeHistoryItem()]),
      '/api/read/article-1': makeLegacyArticle({ id: 'article-1', title: 'A Quiet Morning' }),
    });
    renderReadApp();

    fireEvent.click(await screen.findByRole('button', { name: '查看全部历史' }));
    fireEvent.click(await screen.findByRole('button', { name: /A Quiet Morning/ }));

    expect(await screen.findByRole('heading', { name: 'A Quiet Morning' })).toBeVisible();
    expect(apiCalls('/api/read/article-1').length).toBe(1);
    // 历史进入的遗留检查题只读：回放首答，无提交入口
    expect(screen.getByText('答错了')).toBeVisible();
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
    // 文章来自历史 → 返回按钮回到历史视图
    fireEvent.click(screen.getByRole('button', { name: '← 返回历史' }));
    expect(await screen.findByRole('button', { name: /A Quiet Morning/ })).toBeVisible();
  });
});
