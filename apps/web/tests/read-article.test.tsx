import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiCalls,
  jsonBodyOf,
  makeArticle,
  makeCorrectCheck,
  makeSecondCheck,
  makeWrongCheck,
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

  it('检查题答对：提交调用 check 接口，显示“答对了”并锁定（不可重复提交）', async () => {
    stubApi({ '/api/read/article-1/check': makeCorrectCheck() });
    renderArticle(makeArticle());

    fireEvent.click(screen.getByLabelText('稳定的'));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(await screen.findByText('答对了')).toBeVisible();
    const calls = apiCalls('/api/read/article-1/check');
    expect(calls.length).toBe(1);
    expect(calls[0].init?.method).toBe('POST');
    expect(jsonBodyOf(calls[0])).toEqual({ checkId: 'check-1', selectedOptionId: 'o1' });

    // 提交后锁定：radio 禁用、提交按钮消失
    expect(screen.getByLabelText('稳定的')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
  });

  it('检查题答错：显示正确选项文本与“下次 Today 会安排一题复习”提示', async () => {
    stubApi({ '/api/read/article-1/check': makeWrongCheck() });
    renderArticle(makeArticle());

    fireEvent.click(screen.getByLabelText('干扰甲'));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(await screen.findByText('答错了')).toBeVisible();
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '正确选项：稳定的'),
    ).toBeVisible();
    expect(screen.getByText('下次 Today 会安排一题复习')).toBeVisible();
  });

  it('needsReinforcementMarked=false 时答错不显示复习提示', async () => {
    stubApi({ '/api/read/article-1/check': makeWrongCheck({ needsReinforcementMarked: false }) });
    renderArticle(makeArticle());

    fireEvent.click(screen.getByLabelText('干扰甲'));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(await screen.findByText('答错了')).toBeVisible();
    expect(screen.queryByText('下次 Today 会安排一题复习')).not.toBeInTheDocument();
  });

  it('两道检查题相互独立：第一题提交后第二题仍可作答', async () => {
    stubApi({ '/api/read/article-1/check': makeCorrectCheck() });
    renderArticle(makeArticle({ checks: [makeArticle().checks[0], makeSecondCheck()] }));

    // 第一题答对
    fireEvent.click(screen.getByLabelText('稳定的'));
    fireEvent.click(screen.getAllByRole('button', { name: '提交' })[0]);
    expect(await screen.findByText('答对了')).toBeVisible();

    // 第二题未被锁定，仍可提交
    fireEvent.click(screen.getByLabelText('未加工的'));
    const remaining = screen.getByRole('button', { name: '提交' });
    expect(remaining).toBeEnabled();
    fireEvent.click(remaining);
    await waitFor(() => {
      expect(apiCalls('/api/read/article-1/check').length).toBe(2);
    });
    expect(jsonBodyOf(apiCalls('/api/read/article-1/check')[1])).toEqual({
      checkId: 'check-2',
      selectedOptionId: 'o1',
    });
  });
});
