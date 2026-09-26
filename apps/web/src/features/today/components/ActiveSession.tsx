import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AnswerResponse, SessionTaskEntry, TodayProgress, TodayTaskView } from '@el/shared';
import { Check, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { TaskCard } from './TaskCard';
import { useSessionTasks } from '../api';

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

      {open &&
        createPortal(
          <div
            role="dialog"
            aria-label="任务列表"
            className="fixed inset-0 z-overlay flex items-end justify-center bg-foreground/20"
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
                  // 列表只读：仅已完成或"当前"可点回看/返回；未做（按顺序做，不跳做）与已撤销置灰
                  const disabled = e.canceled || (!e.result && !isCurrent);
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
                        disabled={disabled}
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm',
                          isCurrent ? 'bg-accent-soft' : 'hover:bg-muted',
                          disabled && 'opacity-50',
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
          </div>,
          document.body,
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
  const { data: sessionTasks } = useSessionTasks();
  const entries = sessionTasks?.tasks ?? null;
  /** null = 当前题；数字 = 回看条目索引（列表仅已完成条目可点） */
  const [cursor, setCursor] = useState<number | null>(null);

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
  // 回看（列表只点已完成条目或"当前"）：cursor 只指向已完成条目
  const reviewing = cursor !== null;

  return (
    <div className="space-y-4">
      <ProgressRow
        progress={progress}
        entries={entries}
        currentIdx={currentIdx}
        shownIdx={shownIdx}
        onJump={(i) => setCursor(i)}
      />

      {shownTask ? (
        <TaskCard
          key={shownTask.taskId}
          task={shownTask}
          result={shownResult}
          readOnly={reviewing}
          onAnswered={reviewing ? undefined : (result) => handleAnswered(shownTask, result)}
          onAdvance={reviewing ? undefined : onAdvance}
        />
      ) : (
        <p className="py-16 text-center text-sm text-muted-foreground">正在加载下一题…</p>
      )}
    </div>
  );
}
