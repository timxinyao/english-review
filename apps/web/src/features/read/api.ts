import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ReadArticleType,
  ReadArticleView,
  ReadCheckRequest,
  ReadCheckResponse,
  ReadFavoriteRequest,
  ReadFavoriteResponse,
  ReadGenerateResponse,
  ReadHistoryResponse,
} from '@el/shared';
import { api } from '../../lib/api';

// ---------- 常量与 query keys ----------

export const READ_HISTORY_PAGE_SIZE = 20;
/** 首页“最近”只取 3 篇（PRODUCT §5.3） */
export const READ_RECENT_PAGE_SIZE = 3;

/** history 查询参数（wire 形态；schema 见 packages/shared read.ts 的 ReadHistoryQuery） */
export interface ReadHistoryParams {
  page: number;
  pageSize: number;
  favorite: 'all' | 'true' | 'false';
}

export const readKeys = {
  all: ['read'] as const,
  /** 所有 history 查询（生成/收藏后 invalidate） */
  historyAll: ['read', 'history'] as const,
  history: (params: ReadHistoryParams) => ['read', 'history', params] as const,
  article: (id: string) => ['read', 'article', id] as const,
};

/** 类型中文标签（PRODUCT §8.1：故事/日常场景/小知识/短观点） */
export const READ_TYPE_LABELS: Record<ReadArticleType, string> = {
  story: '故事',
  daily_scene: '日常场景',
  knowledge: '小知识',
  short_opinion: '短观点',
};

// ---------- 请求函数（契约：packages/shared/src/schemas/api/read.ts，已冻结）----------

export function historyQueryString(params: ReadHistoryParams): string {
  const sp = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
    favorite: params.favorite,
  });
  return sp.toString();
}

export function fetchReadHistory(params: ReadHistoryParams): Promise<ReadHistoryResponse> {
  return api<ReadHistoryResponse>(`/api/read/history?${historyQueryString(params)}`);
}

/**
 * 历史文章详情。冻结契约只含 generate/history/favorite/check；
 * 详情端点 GET /api/read/:id 为集成期建议补充（响应即 ReadArticleView）。
 */
export function fetchReadArticle(id: string): Promise<ReadArticleView> {
  return api<ReadArticleView>(`/api/read/${id}`);
}

/** 实时生成（PRODUCT §8.3：用户触发时生成，响应即文章视图） */
export function generateReadArticle(): Promise<ReadGenerateResponse> {
  return api<ReadGenerateResponse>('/api/read/generate', { method: 'POST' });
}

export function setReadFavorite(id: string, favorite: boolean): Promise<ReadFavoriteResponse> {
  return api<ReadFavoriteResponse>(`/api/read/${id}/favorite`, {
    method: 'POST',
    body: JSON.stringify({ favorite } satisfies ReadFavoriteRequest),
  });
}

export function checkReadAnswer(id: string, body: ReadCheckRequest): Promise<ReadCheckResponse> {
  return api<ReadCheckResponse>(`/api/read/${id}/check`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------- hooks ----------

export function useReadHistory(params: ReadHistoryParams) {
  return useQuery({
    queryKey: readKeys.history(params),
    queryFn: () => fetchReadHistory(params),
  });
}

/** 生成成功：文章写入 article 缓存（不回源），并刷新最近/历史列表 */
export function useGenerateRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: generateReadArticle,
    onSuccess: (article) => {
      qc.setQueryData(readKeys.article(article.id), article);
      void qc.invalidateQueries({ queryKey: readKeys.historyAll });
    },
  });
}

/**
 * 文章视图数据：优先使用缓存（生成响应直接写入），历史进入时才请求详情。
 * staleTime Infinity：生成后的文章不回源 GET /api/read/:id，避免多余请求。
 */
export function useReadArticle(id: string) {
  return useQuery({
    queryKey: readKeys.article(id),
    queryFn: () => fetchReadArticle(id),
    enabled: id.length > 0,
    staleTime: Infinity,
  });
}

/**
 * 文章视图内容订阅：以生成响应 / 已加载详情为 initialData；
 * 收藏切换的乐观更新写入同一缓存，视图即时生效。
 */
export function useReadArticleData(article: ReadArticleView) {
  return useQuery({
    queryKey: readKeys.article(article.id),
    queryFn: () => fetchReadArticle(article.id),
    initialData: article,
    staleTime: Infinity,
  });
}

/** 收藏切换：对文章缓存乐观更新，结束后刷新历史列表（星标即时生效） */
export function useFavoriteArticle(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (favorite: boolean) => setReadFavorite(id, favorite),
    onMutate: async (favorite) => {
      await qc.cancelQueries({ queryKey: readKeys.article(id) });
      const previous = qc.getQueryData<ReadArticleView>(readKeys.article(id));
      if (previous) {
        qc.setQueryData(readKeys.article(id), { ...previous, favorite });
      }
      return { previous };
    },
    onError: (_error, _favorite, context) => {
      if (context?.previous) qc.setQueryData(readKeys.article(id), context.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: readKeys.historyAll });
    },
  });
}

/** 检查题作答：判定在服务端（PRODUCT §8.2：答错只标记补强，不影响 Stage） */
export function useCheckAnswer(articleId: string) {
  return useMutation({
    mutationFn: (body: ReadCheckRequest) => checkReadAnswer(articleId, body),
  });
}
