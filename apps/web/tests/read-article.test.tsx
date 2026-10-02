import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiCalls,
  jsonBodyOf,
  makeArticle,
  makeLegacyAnsweredCheck,
  makeLegacyArticle,
  makeLegacyOpenCheck,
  renderArticle,
  stubApi,
} from './read-helpers';

// vitest 未开 globals，@testing-library/react 不会自动 cleanup
afterEach(cleanup);

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

describe('ArticleView（文章视图）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi({});
  });

  it('正文按 \\n\\n 分段渲染，包含朗读全文按钮', () => {
    const { container } = renderArticle(makeArticle());

    const paragraphs = container.querySelectorAll('article p');
    const first = screen.getByText(
      (_, el) => el?.tagName === 'P' && el.textContent?.startsWith('The morning was quiet'),
    );
    expect(first).toBeVisible();
    const second = screen.getByText(
      (_, el) => el?.tagName === 'P' && el.textContent?.startsWith('She chose raw oats'),
    );
    expect(second).toBeVisible();
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: '朗读全文' })).toBeVisible();
  });

  it('focus 高亮：3 个 focus 词各出现一次 → 3 个 mark；old 词不高亮、不展示', () => {
    const { container } = renderArticle(makeArticle());

    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBe(3);
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(['Stable', 'raw', 'give up']);
    // old 词（steady）不出现在“重点复现”列表里，也不在高亮中
    expect(screen.getByText('重点复现')).toBeVisible();
    expect(screen.getByText('stable · raw · give up')).toBeVisible();
    expect(
      screen.queryByText((_, el) => el?.tagName === 'MARK' && el.textContent?.includes('steady')),
    ).not.toBeInTheDocument();
  });

  it('收藏切换：点击星标乐观生效并 POST /api/read/:id/favorite', async () => {
    stubApi({ '/api/read/article-1/favorite': { ok: true, favorite: true } });
    renderArticle(makeArticle({ favorite: false }));

    const star = screen.getByRole('button', { name: '收藏文章' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(star);

    await waitFor(() => {
      expect(apiCalls('/api/read/article-1/favorite').length).toBe(1);
    });
    expect(jsonBodyOf(apiCalls('/api/read/article-1/favorite')[0])).toEqual({ favorite: true });
    expect(screen.getByRole('button', { name: '取消收藏文章' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('V2 纯文章：不渲染检查题区，无任何 check 提交调用', () => {
    renderArticle(makeArticle());

    expect(screen.queryByText('检查题（历史）')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
    expect(apiCalls('/api/read/article-1/check').length).toBe(0);
  });

  it('遗留已答检查题只读回放：显示答错与正确选项，radio 禁用、无提交按钮、无补强提示', () => {
    renderArticle(makeArticle({ checks: [makeLegacyAnsweredCheck()] }));

    expect(screen.getByText('检查题（历史）')).toBeVisible();
    // 首答回放：选了干扰甲、答错，正确选项为“稳定的”
    expect(screen.getByText('答错了')).toBeVisible();
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '正确选项：稳定的'),
    ).toBeVisible();
    // 只读：radio 全部禁用，无提交入口，也不再有补强提示
    expect(screen.getByLabelText('干扰甲')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
    expect(screen.queryByText('下次 Today 会安排一题复习')).not.toBeInTheDocument();
    expect(apiCalls('/api/read/article-1/check').length).toBe(0);
  });

  it('遗留已答（答对）检查题回放：显示答对了，选中项高亮', () => {
    renderArticle(
      makeArticle({
        checks: [
          {
            ...makeLegacyAnsweredCheck(),
            answered: { selectedOptionId: 'o1', correctOptionId: 'o1', correct: true },
          },
        ],
      }),
    );

    expect(screen.getByText('答对了')).toBeVisible();
    expect(screen.getByLabelText('稳定的')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
  });

  it('遗留未答检查题：只读展示（无提交动作、radio 禁用）', () => {
    renderArticle(makeArticle({ checks: [makeLegacyOpenCheck()] }));

    expect(screen.getByText('文中 stable 的意思是什么？')).toBeVisible();
    expect(screen.getByText('历史检查题，仅供查看')).toBeVisible();
    expect(screen.getByLabelText('稳定的')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
    expect(apiCalls('/api/read/article-1/check').length).toBe(0);
  });

  it('遗留文章（已答 + 未答）两题并列，均为只读', () => {
    renderArticle(makeLegacyArticle());

    expect(screen.getByText('答错了')).toBeVisible();
    expect(screen.getByText('历史检查题，仅供查看')).toBeVisible();
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
    expect(apiCalls('/api/read/legacy-article-1/check').length).toBe(0);
  });
});
