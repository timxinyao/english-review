import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/utils';
import {
  LIBRARY_FILTERS,
  libraryKeys,
  libraryListParams,
  fetchLibraryList,
  type LibraryFilterKey,
} from './api';
import { ImportWizard } from './ImportWizard';
import { useDebouncedValue } from './useDebouncedValue';

export function LibraryPage() {
  // 导入向导是 Library 的内部视图（PRODUCT §4.1：仅 PC 提供入口）
  const [view, setView] = useState<'list' | 'import'>('list');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LibraryFilterKey>('all');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, filter]);

  const params = libraryListParams(filter, debouncedSearch, page);
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: libraryKeys.list(params),
    queryFn: () => fetchLibraryList(params),
    placeholderData: keepPreviousData,
  });

  if (view === 'import') {
    return <ImportWizard onExit={() => setView('list')} />;
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const isMainEmpty =
    (data?.items.length ?? 0) === 0 && !debouncedSearch.trim() && filter === 'all';

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="hidden text-lg font-semibold md:block">Library</h1>
        {/* 导入只在 PC（PRODUCT §4.1） */}
        <Button
          variant="neutral"
          size="sm"
          className="hidden md:inline-flex"
          onClick={() => setView('import')}
        >
          导入
        </Button>
      </div>

      <Input
        type="search"
        aria-label="搜索学习项"
        placeholder="搜索 target、释义、例句、标签、来源"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="flex flex-wrap gap-1.5">
        {LIBRARY_FILTERS.map(({ key, label }) => (
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
          <Button variant="neutral" size="sm" onClick={() => void refetch()}>
            重试
          </Button>
        </div>
      )}

      {data && data.items.length === 0 && isMainEmpty && (
        <div className="space-y-3 py-16 text-center">
          <p className="text-sm text-muted-foreground">还没有学习项，点击导入开始</p>
          <Button
            variant="neutral"
            size="sm"
            className="hidden md:inline-flex"
            onClick={() => setView('import')}
          >
            开始导入
          </Button>
        </div>
      )}

      {data && data.items.length === 0 && !isMainEmpty && (
        <p className="py-16 text-center text-sm text-muted-foreground">没有匹配的学习项。</p>
      )}

      {data && data.items.length > 0 && (
        <ul className="border-t border-border">
          {data.items.map((item) => (
            <li key={item.id} className="border-b border-border">
              <Link
                to={`/library/${item.id}`}
                className="block rounded-lg px-1 py-3 transition-colors hover:bg-muted"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium text-foreground">{item.target}</p>
                  {item.tags.length > 0 && (
                    <span className="flex flex-wrap justify-end gap-1">
                      {item.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">{item.meaning}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span>理解 {item.understandingStage}</span>
                  <span aria-hidden>·</span>
                  <span>输出 {item.productionStage}</span>
                  {item.source && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{item.source}</span>
                    </>
                  )}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <Button
            variant="neutral"
            size="sm"
            disabled={page <= 1 || isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            上一页
          </Button>
          <p className="text-xs text-muted-foreground">
            第 {page} / {totalPages} 页 · 共 {data.total} 项
          </p>
          <Button
            variant="neutral"
            size="sm"
            disabled={page >= totalPages || isFetching}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            下一页
          </Button>
        </div>
      )}
    </section>
  );
}
