import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import type {
  ReadArticleView,
  ReadCheckResponse,
  ReadHistoryItem,
  ReadHistoryResponse,
} from '@el/shared';
import { api } from '../src/lib/api';
import { ArticleView } from '../src/features/read/components/ArticleView';
import { ReadPage } from '../src/features/read/ReadPage';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** 在 QueryClient 中渲染整个 Read feature（/read 首页起步） */
export function renderReadApp() {
  const queryClient = makeQueryClient();
  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/read']}>
        <ReadPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...renderResult };
}

/** 在 QueryClient 中直接渲染文章视图（不经 ReadPage） */
export function renderArticle(article: ReadArticleView) {
  const queryClient = makeQueryClient();
  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <ArticleView article={article} />
    </QueryClientProvider>,
  );
  return { queryClient, ...renderResult };
}

// ---------- lib/api mock 工具（与 today-helpers 同一模式）----------

/** 按 path 桩掉 api()；值可为对象或 () => 对象（用于队列/动态返回） */
export function stubApi(handlers: Record<string, unknown | (() => unknown)>) {
  vi.mocked(api).mockImplementation(((path: string) => {
    const handler = handlers[path];
    if (handler === undefined) {
      return Promise.reject(new Error(`stubApi: unexpected api call ${path}`));
    }
    return Promise.resolve(typeof handler === 'function' ? (handler as () => unknown)() : handler);
  }) as typeof api);
}

/** 取出某 path 前缀的全部调用（path + init） */
export function apiCalls(pathPrefix: string): { path: string; init?: RequestInit }[] {
  return vi
    .mocked(api)
    .mock.calls.filter(([p]) => typeof p === 'string' && (p as string).startsWith(pathPrefix))
    .map(([p, init]) => ({ path: p as string, init }));
}

export function jsonBodyOf(call: { init?: RequestInit }): unknown {
  return JSON.parse(call.init?.body as string);
}

// ---------- 常用 URL（与 features/read/api.ts 的构造保持一致）----------

export const RECENT_URL = '/api/read/history?page=1&pageSize=3&favorite=all';
export const HISTORY_URL = '/api/read/history?page=1&pageSize=20&favorite=all';

// ---------- fixtures ----------

/**
 * 正文两段：第一段含 focus 词 stable / raw / give up 各一次（共 3 个高亮），
 * 第二段含 old 词 steady（不高亮）。
 */
export function makeArticle(overrides: Partial<ReadArticleView> = {}): ReadArticleView {
  return {
    id: 'article-1',
    title: 'A Quiet Morning',
    type: 'story',
    body:
      'The morning was quiet, and the plan felt Stable from the start.\n\n' +
      'She chose raw oats for breakfast and promised not to give up, keeping a steady pace.',
    contentLevel: 'B1',
    favorite: false,
    createdAt: '2026-09-24T10:00:00.000Z',
    expiresAt: '2026-10-24T10:00:00.000Z',
    focusItems: [
      { learningItemId: 'i1', target: 'stable', surfaceForm: 'stable' },
      { learningItemId: 'i2', target: 'raw', surfaceForm: 'raw' },
      { learningItemId: 'i3', target: 'give up', surfaceForm: 'give up' },
    ],
    oldItems: [{ learningItemId: 'i4', target: 'steady' }],
    checks: [
      {
        checkId: 'check-1',
        learningItemId: 'i1',
        target: 'stable',
        question: '文中 stable 的意思是什么？',
        options: [
          { id: 'o1', text: '稳定的' },
          { id: 'o2', text: '干扰甲' },
          { id: 'o3', text: '干扰乙' },
          { id: 'o4', text: '干扰丙' },
        ],
      },
    ],
    ...overrides,
  };
}

export function makeSecondCheck(): ReadArticleView['checks'][number] {
  return {
    checkId: 'check-2',
    learningItemId: 'i2',
    target: 'raw',
    question: '文中 raw 的意思是什么？',
    options: [
      { id: 'o1', text: '未加工的' },
      { id: 'o2', text: '干扰甲' },
      { id: 'o3', text: '干扰乙' },
      { id: 'o4', text: '干扰丙' },
    ],
  };
}

export function makeHistoryItem(overrides: Partial<ReadHistoryItem> = {}): ReadHistoryItem {
  return {
    id: 'article-1',
    title: 'A Quiet Morning',
    type: 'story',
    favorite: false,
    // 2 天前（相对时间断言保持确定性）
    createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    wordCount: 260,
    ...overrides,
  };
}

export function makeHistoryResponse(
  items: ReadHistoryItem[],
  total = items.length,
  page = 1,
  pageSize = 20,
): ReadHistoryResponse {
  return { items, total, page, pageSize };
}

export function makeCorrectCheck(overrides: Partial<ReadCheckResponse> = {}): ReadCheckResponse {
  return { correct: true, correctOptionId: 'o1', needsReinforcementMarked: false, ...overrides };
}

export function makeWrongCheck(overrides: Partial<ReadCheckResponse> = {}): ReadCheckResponse {
  return { correct: false, correctOptionId: 'o1', needsReinforcementMarked: true, ...overrides };
}
