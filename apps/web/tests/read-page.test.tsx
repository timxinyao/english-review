import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECENT_URL,
  apiCalls,
  makeArticle,
  makeHistoryItem,
  makeHistoryResponse,
  renderReadApp,
  stubApi,
} from './read-helpers';

// vitest 未开 globals，@testing-library/react 不会自动 cleanup
afterEach(cleanup);

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

describe('Read 首页', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('首屏：唯一主动作“生成阅读” + 最近 3 篇（标题/类型标签/词数/相对时间）+ 查看全部历史入口', async () => {
    stubApi({
      [RECENT_URL]: makeHistoryResponse([
        makeHistoryItem(),
        makeHistoryItem({ id: 'a2', title: 'City Walk', type: 'daily_scene', wordCount: 210 }),
        makeHistoryItem({ id: 'a3', title: 'Why Maps Lie', type: 'knowledge', wordCount: 330 }),
      ]),
    });
    renderReadApp();

    expect(await screen.findByRole('heading', { name: 'Read' })).toBeVisible();
    const generateBtn = screen.getByRole('button', { name: '生成阅读' });
    expect(generateBtn).toBeEnabled();

    expect(await screen.findByText('A Quiet Morning')).toBeVisible();
    expect(screen.getByText('City Walk')).toBeVisible();
    expect(screen.getByText('Why Maps Lie')).toBeVisible();
    // 类型中文标签与词数
    expect(screen.getAllByText('故事').length).toBeGreaterThan(0);
    expect(screen.getByText('日常场景')).toBeVisible();
    expect(screen.getByText('小知识')).toBeVisible();
    expect(screen.getAllByText('260 词').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2 天前').length).toBeGreaterThan(0);

    expect(screen.getByRole('button', { name: '查看全部历史' })).toBeVisible();
  });

  it('点击生成调用 POST /api/read/generate；pending 时显示“生成中，约需十几秒…”且按钮禁用', async () => {
    stubApi({
      [RECENT_URL]: makeHistoryResponse([]),
      // 挂起的 Promise：保持 pending 态
      '/api/read/generate': new Promise(() => {}),
    });
    renderReadApp();

    fireEvent.click(await screen.findByRole('button', { name: '生成阅读' }));

    expect(await screen.findByText('生成中，约需十几秒…')).toBeVisible();
    expect(screen.getByRole('button', { name: '生成阅读' })).toBeDisabled();

    expect(apiCalls('/api/read/generate').length).toBe(1);
    expect(apiCalls('/api/read/generate')[0].init?.method).toBe('POST');
  });

  it('生成失败显示错误并可重试；重试成功进入文章视图', async () => {
    let calls = 0;
    stubApi({
      [RECENT_URL]: makeHistoryResponse([]),
      '/api/read/generate': () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('coverage failed')) : makeArticle();
      },
    });
    renderReadApp();

    fireEvent.click(await screen.findByRole('button', { name: '生成阅读' }));
    expect(await screen.findByText('生成失败，请重试。')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('heading', { name: 'A Quiet Morning' })).toBeVisible();
    expect(screen.getByText('故事')).toBeVisible();
    expect(screen.getByText('重点复现')).toBeVisible();
    expect(screen.getByText(/文中 stable 的意思是什么？/)).toBeVisible();
  });

  it('生成成功进入文章：标题/类型/正文/检查题可见，且不触发 GET /api/read/:id', async () => {
    stubApi({
      [RECENT_URL]: makeHistoryResponse([]),
      '/api/read/generate': makeArticle(),
    });
    renderReadApp();

    fireEvent.click(await screen.findByRole('button', { name: '生成阅读' }));
    expect(await screen.findByRole('heading', { name: 'A Quiet Morning' })).toBeVisible();
    // 生成响应直接作为文章数据（契约：响应即文章视图）
    expect(apiCalls('/api/read/article-1').length).toBe(0);
  });

  it('点击最近列表项进入文章（GET /api/read/:id 加载详情）', async () => {
    stubApi({
      [RECENT_URL]: makeHistoryResponse([makeHistoryItem()]),
      '/api/read/article-1': makeArticle(),
    });
    renderReadApp();

    fireEvent.click(await screen.findByRole('button', { name: /A Quiet Morning/ }));

    expect(await screen.findByRole('heading', { name: 'A Quiet Morning' })).toBeVisible();
    expect(apiCalls('/api/read/article-1').length).toBe(1);
  });
});
