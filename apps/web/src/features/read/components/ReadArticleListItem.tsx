import type { ReadHistoryItem } from '@el/shared';
import { Star } from 'lucide-react';
import { READ_TYPE_LABELS } from '../api';
import { relativeTime } from '../time';

/** 最近/历史共用的文章摘要行（Quiet UI：一行标题 + 一行元信息，星标只读） */
export function ReadArticleListItem({
  item,
  onOpen,
}: {
  item: ReadHistoryItem;
  onOpen: (id: string) => void;
}) {
  return (
    <li className="border-b border-border">
      <button
        type="button"
        onClick={() => onOpen(item.id)}
        className="block w-full rounded-lg px-1 py-3 text-left transition-colors hover:bg-muted"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-foreground">{item.title}</p>
          {item.favorite && (
            <Star
              aria-label="已收藏"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-accent text-accent"
            />
          )}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{READ_TYPE_LABELS[item.type]}</span>
          <span aria-hidden>·</span>
          <span>{item.wordCount} 词</span>
          <span aria-hidden>·</span>
          <span>{relativeTime(item.createdAt)}</span>
        </p>
      </button>
    </li>
  );
}
