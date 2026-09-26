import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerResponse, TodayProgress, TodayTaskView } from '@el/shared';
import { Check, ChevronLeft, X } from 'lucide-react';
import { CORRECT_AUTO_ADVANCE_MS } from '../../../lib/questions';
import { cn } from '../../../lib/utils';
import { TaskCard } from './TaskCard';
import { useLater } from '../api';

export { CORRECT_AUTO_ADVANCE_MS };

const MANUAL_ADVANCE_TYPES: ReadonlySet<TodayTaskView['taskType']> = new Set([
  'cloze',
  'production',
]);

export interface FrozenAnswer {
  task: TodayTaskView;
  result: AnswerResponse;
}

/** 历史记录条目：已完成任务 + 冻结结果 */
interface HistoryEntry {
  task: TodayTaskView;
  result: AnswerResponse;
}

/** 进度行 + 可点击弹出单词列表 */
function ProgressRow({
  completed,
  total,
  history,
  currentTarget,
  onJump,
}: {
  completed: number;
  total: number;
  history: HistoryEntry[];
  currentTarget: string | null;
  onJump: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        className="flex w-full items-center justify-between"
        onClick={() => setOpen(true)}
        aria-label="查看任务列表"
      >
        <p className="text-xs text-muted-foreground">
          {completed} / {total}
        </p>
        <p className="text-xs text-muted-foreground/60">列表 ▾</p>
      </button>
      {total > 0 && (
        <div className="flex gap-0.5" aria-hidden>
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={cn('h-1 flex-1 rounded-full', i < completed ? 'bg-accent' : 'bg-muted')}
            />
          ))}
        </div>
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
              {history.map((h, i) => (
                <li key={h.task.taskId}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-muted"
                    onClick={() => {
                      onJump(i);
                      setOpen(false);
                    }}
                  >
                    <span className="text-foreground">{h.task.item.target}</span>
                    <span
                      className={cn(
                        'flex items-center gap-1 text-xs',
                        h.result.correct ? 'text-success' : 'text-destructive',
                      )}
                    >
                      {h.result.correct ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      {h.result.correct ? '对' : '错'}
                    </span>
                  </button>
                </li>
              ))}
              {currentTarget && (
                <li className="flex items-center justify-between rounded-lg bg-accent-soft px-3 py-2 text-sm">
                  <span className="font-medium text-accent">{currentTarget}</span>
                  <span className="text-xs text-accent/70">当前</span>
                </li>
              )}
              <li className="px-3 py-2 text-xs text-muted-foreground/50">后续任务完成前不可跳转</li>
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
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  /** -1 = 最后一个历史，-2 = 倒数第二个…；null = 当前任务 */
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  const answeredTaskIds = useRef<Set<string>>(new Set());

  const handleHoldChange = useCallback((next: boolean) => setHold(next), []);

  const handleAnswered = useCallback(
    (task: TodayTaskView, result: AnswerResponse) => {
      answeredTaskIds.current.add(task.taskId);
      setHistory((prev) => [...prev, { task, result }]);
      setViewIndex(null); // 确保回到当前
      onAnswered({ task, result });
    },
    [onAnswered],
  );

  // 自动下一题（仅当前任务答对且不在回看模式）
  useEffect(() => {
    if (viewIndex !== null) return; // 回看模式不自动跳
    if (!frozen || !frozen.result.correct || MANUAL_ADVANCE_TYPES.has(frozen.task.taskType) || hold)
      return;
    const timer = setTimeout(onAdvance, CORRECT_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [frozen, hold, onAdvance, viewIndex]);

  const nextTask =
    currentTask && !answeredTaskIds.current.has(currentTask.taskId) ? currentTask : null;

  // 回看模式：显示历史条目
  const reviewing = viewIndex !== null && history[viewIndex];
  const shownTask = reviewing ? reviewing.task : (frozen?.task ?? nextTask);
  const shownResult = reviewing ? reviewing.result : (frozen?.result ?? null);
  const isReviewMode = reviewing !== null && viewIndex !== null;

  // 自定义滑动：左滑上一题，右滑下一题/返回当前
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (t) touchStart.current = { x: t.clientX, y: t.clientY };
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    touchStart.current = null;

    // 必须是水平主导且距离够长（避免误触和垂直滚动干扰）
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    if (dx < 0) {
      // 左滑 → 上一题
      if (viewIndex === null && history.length > 0) {
        setViewIndex(history.length - 1);
      } else if (viewIndex !== null && viewIndex > 0) {
        setViewIndex(viewIndex - 1);
      }
    } else {
      // 右滑 → 下一题 / 返回当前
      if (viewIndex !== null) {
        if (viewIndex < history.length - 1) {
          setViewIndex(viewIndex + 1);
        } else {
          setViewIndex(null);
        }
      } else if (frozen?.result) {
        onAdvance();
      } else if (nextTask) {
        // 未答题右滑 = 稍后再做（推到队尾，refetch 拿到下一题）
        later.mutate(nextTask.taskId);
      }
    }
  }

  return (
    <div className="space-y-4" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {/* 导航行：回看时显示返回，正常时显示上一题（有历史才显示） */}
      {isReviewMode ? (
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground"
          onClick={() => setViewIndex(null)}
        >
          <ChevronLeft className="h-3 w-3" aria-hidden />
          返回当前
        </button>
      ) : null}

      {progress && (
        <ProgressRow
          completed={progress.completed}
          total={progress.total}
          history={history}
          currentTarget={shownTask?.item.target ?? null}
          onJump={(i) => setViewIndex(i)}
        />
      )}

      {shownTask ? (
        <TaskCard
          key={shownTask.taskId}
          task={shownTask}
          result={shownResult}
          readOnly={isReviewMode}
          onAnswered={isReviewMode ? undefined : (result) => handleAnswered(shownTask, result)}
          onAdvance={isReviewMode ? undefined : onAdvance}
          onHoldChange={isReviewMode ? undefined : handleHoldChange}
        />
      ) : (
        <p className="py-16 text-center text-sm text-muted-foreground">正在加载下一题…</p>
      )}
    </div>
  );
}
