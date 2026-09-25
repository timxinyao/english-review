import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils';
import { READ_HISTORY_PAGE_SIZE, fetchReadHistory, readKeys, type ReadHistoryParams } from '../api';
import { ReadArticleListItem } from './ReadArticleListItem';

export const READ_HISTORY_FILTERS = [
  { key: 'all', label: '全部', favorite: 'all' },
  { key: 'favorite', label: '收藏', favorite: 'true' },
] as const;

export type ReadHistoryFilterKey = (typeof READ_HISTORY_FILTERS)[number]['key'];

/** Read 历史视图（PRODUCT §8.3）：分页列表 + 全部/收藏筛选；点击进入文章 */
export function ReadHistoryView({ onOpenArticle }: { onOpenArticle: (id: string) => void }) {
  const [filter, setFilter] = useState<ReadHistoryFilterKey>('all');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [filter]);

  const params: ReadHistoryParams = {
    page,
    pageSize: READ_HISTORY_PAGE_SIZE,
    favorite: READ_HISTORY_FILTERS.find((f) => f.key === filter)?.favorite ?? 'all',
  };
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: readKeys.history(params),
    queryFn: () => fetchReadHistory(params),
    placeholderData: keepPreviousData,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Read 历史</h1>

      <div className="flex flex-wrap gap-1.5">
        {READ_HISTORY_FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              filter === key
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {isLoading && <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>}
      {isError && (
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm text-destructive">读取失败，请重试。</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            重试
          </Button>
        </div>
      )}

      {data && data.items.length === 0 && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {filter === 'favorite' ? '还没有收藏的文章。' : '还没有阅读记录，生成第一篇吧。'}
        </p>
      )}

      {data && data.items.length > 0 && (
        <ul className="border-t border-border">
          {data.items.map((item) => (
            <ReadArticleListItem key={item.id} item={item} onOpen={onOpenArticle} />
          ))}
        </ul>
      )}

      {data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            上一页
          </Button>
          <p className="text-xs text-muted-foreground">
            第 {page} / {totalPages} 页 · 共 {data.total} 篇
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || isFetching}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            下一页
          </Button>
        </div>
      )}
    </div>
  );
}
