import { useMemo } from 'react';
import type { ReadArticleView } from '@el/shared';
import { Star, Volume2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { HighlightText } from '../../../components/highlight-text';
import { cn } from '../../../lib/utils';
import { speak } from '../../../lib/tts';
import { READ_TYPE_LABELS, useFavoriteArticle, useReadArticleData } from '../api';
import { relativeTime } from '../time';
import { ReadCheckItem } from './ReadCheckItem';

/** 正文段落：focus 词与 surfaceForm 全部走全局 HighlightText（多目标 + 词形变体/占位代词能力） */
function HighlightedParagraph({ text, targets }: { text: string; targets: string[] }) {
  return (
    <p className="leading-8 text-foreground">
      <HighlightText text={text} target={targets} />
    </p>
  );
}

/**
 * 文章视图（PRODUCT §5.3/§8，V2 纯阅读）：标题/类型/收藏/时间 + 高亮正文 + 重点复现。
 * old 词不展示、不高亮；V2 新文章无检查题，V1 遗留检查题只读回放（无提交入口）。
 * favorite 等经 article 缓存订阅（收藏乐观更新即时生效）。
 */
export function ArticleView({ article: initial }: { article: ReadArticleView }) {
  const { data } = useReadArticleData(initial);
  const article = data ?? initial;
  const favorite = useFavoriteArticle(article.id);
  const highlightTargets = useMemo(
    () =>
      [
        ...new Set(article.focusItems.flatMap((f) => [f.target, f.surfaceForm].filter(Boolean))),
      ].filter((t): t is string => t !== null && t.length > 0),
    [article.focusItems],
  );
  const paragraphs = useMemo(() => article.body.split('\n\n'), [article.body]);

  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h1 className="text-xl font-semibold text-foreground">{article.title}</h1>
          <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            {READ_TYPE_LABELS[article.type]}
          </span>
          <button
            type="button"
            aria-pressed={article.favorite}
            aria-label={article.favorite ? '取消收藏文章' : '收藏文章'}
            disabled={favorite.isPending}
            onClick={() => favorite.mutate(!article.favorite)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted"
          >
            <Star
              aria-hidden
              className={cn('h-4 w-4', article.favorite && 'fill-accent text-accent')}
            />
          </button>
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{relativeTime(article.createdAt)}</span>
          <span aria-hidden>·</span>
          <span>{article.contentLevel}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => speak(article.body, { userGesture: true })}
          >
            <Volume2 className="h-4 w-4" aria-hidden />
            朗读全文
          </Button>
        </p>
      </header>

      <div className="space-y-4 text-base">
        {paragraphs.map((paragraph, i) => (
          <HighlightedParagraph key={i} text={paragraph} targets={highlightTargets} />
        ))}
      </div>

      <section className="space-y-1.5" aria-label="重点复现">
        <p className="text-xs font-medium tracking-wide text-muted-foreground">重点复现</p>
        <p className="text-sm text-muted-foreground">
          {article.focusItems.map((f) => f.target).join(' · ')}
        </p>
      </section>

      {article.checks.length > 0 && (
        <section className="space-y-4 border-t border-border pt-4">
          <h2 className="text-sm font-medium">检查题（历史）</h2>
          {article.checks.map((check, i) => (
            <ReadCheckItem key={check.checkId} check={check} index={i} />
          ))}
        </section>
      )}
    </article>
  );
}
