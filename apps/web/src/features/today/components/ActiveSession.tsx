import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AnswerResponse, SessionTaskEntry, TodayProgress, TodayTaskView } from '@el/shared';
import { Check, ChevronLeft, X } from 'lucide-react';
import { CORRECT_AUTO_ADVANCE_MS } from '../../../lib/questions';
import { cn } from '../../../lib/utils';
import { SwipeDeck } from './SwipeDeck';
import { TaskCard } from './TaskCard';
import { useLater, useSessionTasks } from '../api';

export { CORRECT_AUTO_ADVANCE_MS };

const MANUAL_ADVANCE_TYPES: ReadonlySet<TodayTaskView['taskType']> = new Set([
  'cloze',
  'production',
]);

const TYPE_LABEL: Record<TodayTaskView['taskType'], string> = {
  learn: 'learn',
  understanding: '理解',
  cloze: '填空',
  production: '表达',
};

export interface FrozenAnswer {
  task: TodayTaskView;
  result: AnswerResponse;
}

/** 进度行：当前位置数字 + 按题完成着色分段 + 全量任务弹层 */
function ProgressRow({
  progress,
  entries,
  currentIdx,
  shownIdx,
  onJump,
}: {
  progress: TodayProgress | null;
  entries: SessionTaskEntry[] | null;
  currentIdx: number | null;
  shownIdx: number | null;
  onJump: (index: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasEntries = !!entries && entries.length > 0;
  const position = hasEntries && shownIdx !== null ? shownIdx + 1 : null;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        className="flex w-full items-center justify-between"
        onClick={() => setOpen(true)}
        aria-label="查看任务列表"
      >
        <p className="text-xs text-muted-foreground">
          {position !== null
            ? `第 ${position} / ${entries!.length}`
            : progress
              ? `${progress.completed} / ${progress.total}`
              : ''}
        </p>
        <p className="text-xs text-muted-foreground/60">列表 ▾</p>
      </button>
      {hasEntries ? (
        <div className="flex gap-0.5" aria-hidden>
          {entries!.map((e, i) => (
            <span
              key={e.task.taskId}
              data-seg={e.result ? 'done' : 'todo'}
              data-current={i === shownIdx}
              className={cn(
                'flex-1 rounded-full',
                i === shownIdx ? 'h-1.5' : 'h-1',
                e.result ? 'bg-accent' : 'bg-muted',
              )}
            />
          ))}
        </div>
      ) : (
        progress &&
        progress.total > 0 && (
          <div className="flex gap-0.5" aria-hidden>
            {Array.from({ length: progress.total }, (_, i) => (
              <span
                key={i}
                className={cn('h-1 flex-1 rounded-full', i < progress.completed ? 'bg-accent' : 'bg-muted')}
              />
            ))}
          </div>
        )
      )}

      {open && (
        <div
          role="dialog"
          aria-label="任务列表"
          className="fixed inset-0 z-40 flex items-end justify-center bg-foreground/20"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[60vh] w-full max-w-[420px] overflow-y-auto rounded-t-xl border-t border-border bg-card p-4 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-3 text-sm font-medium">任务列表</p>
            <ul className="space-y-1">
              {entries?.map((e, i) => {
                const isCurrent = i === currentIdx;
                const status = e.canceled
                  ? '已撤销'
                  : e.result
                    ? e.result.correct
                      ? '对'
                      : '错'
                    : isCurrent
                      ? '当前'
                      : '未做';
                return (
                  <li key={e.task.taskId}>
                    <button
                      type="button"
                      disabled={e.canceled}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm',
                        isCurrent ? 'bg-accent-soft' : 'hover:bg-muted',
                        e.canceled && 'opacity-50',
                      )}
                      onClick={() => {
                        onJump(isCurrent ? null : i);
                        setOpen(false);
                      }}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className={cn('text-foreground', isCurrent && 'font-medium text-accent')}>
                          {e.task.item.target}
                        </span>
                        <span className="text-xs text-muted-foreground/60">
                          {TYPE_LABEL[e.task.taskType]}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'flex items-center gap-1 text-xs',
                          e.result?.correct
                            ? 'text-success'
                            : e.result
                              ? 'text-destructive'
                              : 'text-muted-foreground',
                        )}
                      >
                        {e.result ? (
                          e.result.correct ? (
                            <Check className="h-3 w-3" aria-hidden />
                          ) : (
                            <X className="h-3 w-3" aria-hidden />
                          )
                        ) : null}
                        {status}
                      </span>
                    </button>
                  </li>
                );
              }) ?? null}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

interface ActiveSessionProps {
  progress: TodayProgress | null;
  currentTask: TodayTaskView | null;
  frozen: FrozenAnswer | null;
  onAnswered: (frozen: FrozenAnswer) => void;
  onAdvance: () => void;
}

export function ActiveSession({
  progress,
  currentTask,
  frozen,
  onAnswered,
  onAdvance,
}: ActiveSessionProps) {
  const [hold, setHold] = useState(false);
  const later = useLater();
  const { data: sessionTasks } = useSessionTasks();
  const entries = sessionTasks?.tasks ?? null;
  /** null = 当前题；数字 = 回看/跳做条目索引 */
  const [cursor, setCursor] = useState<number | null>(null);

  const handleHoldChange = useCallback((next: boolean) => setHold(next), []);

  // 当前题在会话序列中的索引（以 currentTask/frozen 的 taskId 定位；兜底第一个未完成）
  const currentIdx = useMemo(() => {
    if (!entries || entries.length === 0) return null;
    const id = frozen?.task.taskId ?? currentTask?.taskId ?? null;
    let idx = id !== null ? entries.findIndex((e) => e.task.taskId === id) : -1;
    if (idx === -1) {
      idx = entries.findIndex((e) => !e.canceled && e.result === null);
      if (idx === -1) idx = entries.length - 1;
    }
    return idx;
  }, [entries, currentTask, frozen]);

  const handleAnswered = useCallback(
    (task: TodayTaskView, result: AnswerResponse) => {
      setCursor(null); // 确保回到当前
      onAnswered({ task, result });
    },
    [onAnswered],
  );

  // 答对自动下一题（仅当前题、非回看/跳做）
  useEffect(() => {
    if (cursor !== null) return;
    if (!frozen || !frozen.result.correct || MANUAL_ADVANCE_TYPES.has(frozen.task.taskType) || hold)
      return;
    const timer = setTimeout(onAdvance, CORRECT_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [frozen, hold, onAdvance, cursor]);

  const shownIdx = cursor ?? currentIdx;
  const entry = entries && shownIdx !== null && shownIdx < entries.length ? entries[shownIdx]! : null;
  const isCurrent = cursor === null;
  // 当前题视图必须信任 props（frozen/currentTask）：答错/跳做后 invalidate refetch 落地时
  // 批量 entries 已指向新的当前题，取 entry.task 会渲染"新题卡 + 旧题反馈"错配，
  // 坏题等操作也会 mutate 到错误的 taskId
  const shownTask = isCurrent
    ? (frozen?.task ?? currentTask ?? entry?.task)
    : (entry?.task ?? frozen?.task ?? currentTask);
  const shownResult = isCurrent ? (frozen?.result ?? null) : (entry?.result ?? null);
  // 跳做未完成任务 = 可作答；回看已完成 = 只读
  const reviewing = !isCurrent && (entry === null || entry.result !== null);

  // 相邻导航（跳过撤销条目）；返回 false = 边界回弹；右向越过末尾 = 回到当前题
  const stepCursor = useCallback(
    (dir: -1 | 1): boolean => {
      if (!entries || entries.length === 0) return false;
      const from = cursor ?? currentIdx;
      if (from === null) return false;
      let i = from + dir;
      while (i >= 0 && i < entries.length && entries[i]!.canceled) i += dir;
      if (i < 0) return false;
      if (i >= entries.length) {
        setCursor(null);
        return true;
      }
      setCursor(i === currentIdx ? null : i);
      return true;
    },
    [entries, cursor, currentIdx],
  );

  const handleSwipeLeft = useCallback((): boolean => stepCursor(-1), [stepCursor]);

  const handleSwipeRight = useCallback((): boolean => {
    if (cursor !== null) return stepCursor(1);
    // 当前题：已答 → 下一题；未答 → 稍后再做（推到队尾）
    if (frozen?.result) {
      onAdvance();
      return true;
    }
    if (currentTask) {
      later.mutate(currentTask.taskId);
      return true;
    }
    return false;
  }, [cursor, stepCursor, frozen, currentTask, later, onAdvance]);

  // 键盘 ←/→ 与滑动同语义（输入框聚焦时忽略）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowLeft') handleSwipeLeft();
      if (e.key === 'ArrowRight') handleSwipeRight();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSwipeLeft, handleSwipeRight]);

  return (
    <SwipeDeck className="space-y-4" onSwipeLeft={handleSwipeLeft} onSwipeRight={handleSwipeRight}>
      {reviewing ? (
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground"
          onClick={() => setCursor(null)}
        >
          <ChevronLeft className="h-3 w-3" aria-hidden />
          返回当前
        </button>
      ) : null}

      <ProgressRow
        progress={progress}
        entries={entries}
        currentIdx={currentIdx}
        shownIdx={shownIdx}
        onJump={(i) => setCursor(i)}
      />

      <div data-swipe-card style={{ willChange: 'transform', backfaceVisibility: 'hidden' }}>
        {shownTask ? (
          <TaskCard
            key={shownTask.taskId}
            task={shownTask}
            result={shownResult}
            readOnly={reviewing}
            onAnswered={reviewing ? undefined : (result) => handleAnswered(shownTask, result)}
            onAdvance={reviewing ? undefined : onAdvance}
            onHoldChange={reviewing ? undefined : handleHoldChange}
          />
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">正在加载下一题…</p>
        )}
      </div>
    </SwipeDeck>
  );
}
