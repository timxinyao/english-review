import { useMemo } from 'react';
import type { ReadArticleView } from '@el/shared';
import { Star, Volume2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils';
import { speak } from '../../../lib/tts';
import { READ_TYPE_LABELS, useFavoriteArticle, useReadArticleData } from '../api';
import { highlightParts } from '../highlight';
import { relativeTime } from '../time';
import { ReadCheckItem } from './ReadCheckItem';

/** 正文段落：focus surfaceForm 大小写不敏感轻微高亮（accent-soft 背景） */
function HighlightedParagraph({ text, surfaceForms }: { text: string; surfaceForms: string[] }) {
  const parts = useMemo(() => highlightParts(text, surfaceForms), [text, surfaceForms]);
  return (
    <p className="leading-8 text-foreground">
      {parts.map((part, i) =>
        part.highlighted ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </p>
  );
}

/**
 * 文章视图（PRODUCT §5.3/§8）：标题/类型/收藏/时间 + 高亮正文 + 重点复现 + 检查题。
 * old 词不展示、不高亮；检查题不 shuffle、每题提交一次后锁定。
 * favorite 等经 article 缓存订阅（收藏乐观更新即时生效）。
 */
export function ArticleView({ article: initial }: { article: ReadArticleView }) {
  const { data } = useReadArticleData(initial);
  const article = data ?? initial;
  const favorite = useFavoriteArticle(article.id);
  const surfaceForms = useMemo(
    () => article.focusItems.map((f) => f.surfaceForm),
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
          <Button variant="ghost" size="sm" onClick={() => speak(article.body, { userGesture: true })}>
            <Volume2 className="h-4 w-4" aria-hidden />
            朗读全文
          </Button>
        </p>
      </header>

      <div className="space-y-4 text-base">
        {paragraphs.map((paragraph, i) => (
          <HighlightedParagraph key={i} text={paragraph} surfaceForms={surfaceForms} />
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
          <h2 className="text-sm font-medium">检查题</h2>
          {article.checks.map((check, i) => (
            <ReadCheckItem key={check.checkId} articleId={article.id} check={check} index={i} />
          ))}
        </section>
      )}
    </article>
  );
}
