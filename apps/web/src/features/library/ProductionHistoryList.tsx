import type { LibraryItemDetail } from '@el/shared';
import { cn } from '../../lib/utils';

type HistoryEntry = LibraryItemDetail['productionHistory'][number];

const RESULT_LABELS: Record<HistoryEntry['result'], string> = {
  pass: '通过',
  basic_pass: '基本通过',
  fail: '未通过',
  void: '已作废',
};

const RESULT_CLASSES: Record<HistoryEntry['result'], string> = {
  pass: 'text-success',
  basic_pass: 'text-muted-foreground',
  fail: 'text-destructive',
  void: 'text-muted-foreground',
};

/** 近期造句历史（PRODUCT §7.5：每项最多 10 次，服务端按时间倒序）；空则不渲染 */
export function ProductionHistoryList({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) return null;

  return (
    <section className="space-y-2" aria-label="造句历史">
      <h2 className="text-sm font-medium">造句历史</h2>
      <ul>
        {history.map((entry) => (
          <li key={entry.id} className="space-y-1 border-b border-border py-2.5 last:border-b-0">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm text-foreground">
                {entry.correctedSentence ?? entry.originalText ?? '—'}
              </p>
              <span
                className={cn(
                  'shrink-0 rounded border border-border px-1.5 py-0.5 text-xs',
                  RESULT_CLASSES[entry.result],
                )}
              >
                {RESULT_LABELS[entry.result]}
              </span>
            </div>
            {entry.originalText && entry.originalText !== entry.correctedSentence && (
              <p className="text-xs text-muted-foreground">原句：{entry.originalText}</p>
            )}
            {entry.betterVersion && (
              <p className="text-xs text-muted-foreground">
                {entry.betterVersionKind === 'rewrite' ? '参考表达：' : '更自然：'}
                {entry.betterVersion}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
