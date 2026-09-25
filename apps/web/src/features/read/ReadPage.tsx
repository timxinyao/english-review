import { useState } from 'react';
import type { ReadGenerateResponse } from '@el/shared';
import { Button } from '../../components/ui/button';
import { READ_RECENT_PAGE_SIZE, useGenerateRead, useReadArticle, useReadHistory } from './api';
import { ArticleView } from './components/ArticleView';
import { ReadArticleListItem } from './components/ReadArticleListItem';
import { ReadHistoryView } from './components/ReadHistoryView';

type ReadView =
  | { kind: 'home' }
  | { kind: 'history' }
  | { kind: 'article'; articleId: string; from: 'home' | 'history' };

/**
 * Read 页（PRODUCT §5.3/§8）：首页一页一个主动作——生成阅读；
 * 历史/文章为页内视图切换。Read 不影响 Today 完成状态。
 */
export function ReadPage() {
  const [view, setView] = useState<ReadView>({ kind: 'home' });

  if (view.kind === 'history') {
    return (
      <section className="space-y-4">
        <button
          type="button"
          onClick={() => setView({ kind: 'home' })}
          className="text-sm text-muted-foreground transition-colors hover:text-accent"
        >
          ← 返回 Read
        </button>
        <ReadHistoryView
          onOpenArticle={(articleId) => setView({ kind: 'article', articleId, from: 'history' })}
        />
      </section>
    );
  }

  if (view.kind === 'article') {
    const back: ReadView = view.from === 'history' ? { kind: 'history' } : { kind: 'home' };
    return (
      <section className="space-y-4">
        <button
          type="button"
          onClick={() => setView(back)}
          className="text-sm text-muted-foreground transition-colors hover:text-accent"
        >
          {view.from === 'history' ? '← 返回历史' : '← 返回 Read'}
        </button>
        <ReadArticle articleId={view.articleId} />
      </section>
    );
  }

  return (
    <ReadHome
      onGenerated={(articleId) => setView({ kind: 'article', articleId, from: 'home' })}
      onOpenArticle={(articleId) => setView({ kind: 'article', articleId, from: 'home' })}
      onOpenHistory={() => setView({ kind: 'history' })}
    />
  );
}

/** 文章数据：生成响应已写入缓存，历史进入时才请求详情 */
function ReadArticle({ articleId }: { articleId: string }) {
  const { data, isLoading, refetch } = useReadArticle(articleId);

  if (data) return <ArticleView article={data} />;
  if (isLoading) return <p className="py-16 text-center text-sm text-muted-foreground">加载中…</p>;
  return (
    <div className="space-y-2 py-8 text-center">
      <p className="text-sm text-destructive">文章加载失败，请重试。</p>
      <Button variant="outline" size="sm" onClick={() => void refetch()}>
        重试
      </Button>
    </div>
  );
}

/** 首页：主按钮 + 最近 3 篇（PRODUCT §5.3） */
function ReadHome({
  onGenerated,
  onOpenArticle,
  onOpenHistory,
}: {
  onGenerated: (articleId: string) => void;
  onOpenArticle: (articleId: string) => void;
  onOpenHistory: () => void;
}) {
  const generate = useGenerateRead();
  const recent = useReadHistory({
    page: 1,
    pageSize: READ_RECENT_PAGE_SIZE,
    favorite: 'all',
  });

  function generateOnce(): void {
    if (generate.isPending) return; // 生成中禁用重复点击
    generate.mutate(undefined, {
      onSuccess: (article: ReadGenerateResponse) => onGenerated(article.id),
    });
  }

  return (
    <section className="space-y-8">
      <h1 className="text-lg font-semibold">Read</h1>

      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">让近期学过的词在新的上下文里再次出现</p>
        <Button size="lg" className="mt-5" disabled={generate.isPending} onClick={generateOnce}>
          生成阅读
        </Button>
        {generate.isPending && (
          <p className="mt-3 text-xs text-muted-foreground">生成中，约需十几秒…</p>
        )}
        {generate.isError && (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-destructive">生成失败，请重试。</p>
            <Button
              variant="outline"
              size="sm"
              disabled={generate.isPending}
              onClick={generateOnce}
            >
              重试
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-medium tracking-wide text-muted-foreground">最近</p>
          <button
            type="button"
            onClick={onOpenHistory}
            className="text-xs text-accent transition-colors hover:underline"
          >
            查看全部历史
          </button>
        </div>
        {recent.data && recent.data.items.length === 0 && (
          <p className="py-6 text-sm text-muted-foreground">还没有阅读记录，生成第一篇吧。</p>
        )}
        {recent.data && recent.data.items.length > 0 && (
          <ul className="border-t border-border">
            {recent.data.items.map((item) => (
              <ReadArticleListItem key={item.id} item={item} onOpen={onOpenArticle} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
