import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AnswerResponse, SessionTaskEntry, TodayProgress, TodayTaskView } from '@el/shared';
import { Check, Volume2, VolumeX, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { speak } from '../../../lib/tts';
import { TaskCard } from './TaskCard';
import { useSessionTasks } from '../api';

export const TYPE_LABEL: Record<TodayTaskView['taskType'], string> = {
  learn: 'learn',
  understanding: '理解',
  cloze: '填空',
  production: '表达',
};

export interface FrozenAnswer {
  task: TodayTaskView;
  result: AnswerResponse;
  autoAdvance?: boolean;
}

/** 进度行：当前位置数字 + 按题完成着色分段 + 全量任务弹层 */
function ProgressRow({
  progress,
  entries,
  currentIdx,
  shownIdx,
  autoSpeak,
  onToggleAutoSpeak,
  onJump,
}: {
  progress: TodayProgress | null;
  entries: SessionTaskEntry[] | null;
  currentIdx: number | null;
  shownIdx: number | null;
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  onJump: (index: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasEntries = !!entries && entries.length > 0;
  const position = hasEntries && shownIdx !== null ? shownIdx + 1 : null;

  return (
    <div className="space-y-1.5">
      {/* 音量开关与列表按钮为兄弟节点：button 内嵌 button 是非法嵌套
          （React validateDOMNesting 报错，且点击会冒泡误开列表弹层） */}
      <div className="flex w-full items-center justify-between">
        <button
          type="button"
          className="flex flex-1 items-center justify-between"
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
        <button
          type="button"
          aria-label="自动发音"
          aria-pressed={autoSpeak}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          onClick={onToggleAutoSpeak}
        >
          {autoSpeak ? (
            <Volume2 className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <VolumeX className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      </div>
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
  /** 评分即前进的刷新窗口（autoAdvance 且刷新未失败）：true 时乐观渲染预取队列的下一题 */
  advancing?: boolean;
  onAnswered: (frozen: FrozenAnswer) => void;
  onAdvance: () => void;
}

export function ActiveSession({
  progress,
  currentTask,
  frozen,
  advancing,
  onAnswered,
  onAdvance,
}: ActiveSessionProps) {
  const { data: sessionTasks } = useSessionTasks();
  const entries = sessionTasks?.tasks ?? null;
  /** null = 当前题；数字 = 回看条目索引（列表仅已完成条目可点） */
  const [cursor, setCursor] = useState<number | null>(null);
  /** 切卡自动读词（设备本地偏好）：缺省开，'0'=关 */
  const [autoSpeak, setAutoSpeak] = useState(() => localStorage.getItem('el:auto-pronounce') !== '0');

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
    (task: TodayTaskView, result: AnswerResponse, opts?: { autoAdvance?: boolean }) => {
      setCursor(null); // 确保回到当前
      onAnswered({ task, result, autoAdvance: opts?.autoAdvance });
    },
    [onAnswered],
  );

  const isCurrent = cursor === null;
  // 乐观直切（评分即前进）：状态刷新落地前，用预取队列直接渲染下一题——服务端补强
  // 至少插在当前题 3 位之后（TECHNICAL §7.2），紧跟下一题稳定；末题无 entry 回落占位。
  // 刷新落地 advance() 后 frozen 清空、currentTask 接管，同一 taskId 无感衔接；
  // 刷新失败（advancing=false）仍回落旧题反馈页人工兜底。
  const optimisticEntry =
    isCurrent && advancing && entries !== null && currentIdx !== null && currentIdx + 1 < entries.length
      ? entries[currentIdx + 1]!
      : null;
  const usableOptimistic =
    optimisticEntry && !optimisticEntry.canceled && optimisticEntry.result === null
      ? optimisticEntry
      : null;
  const displayIdx = usableOptimistic && currentIdx !== null ? currentIdx + 1 : currentIdx;
  // 窗口内但无可乐观的下一题（末题/队列未就绪）：占位等待，不渲染旧题反馈页
  const optimisticHold = isCurrent && advancing === true && !usableOptimistic;
  const shownIdx = cursor ?? displayIdx;
  const entry = entries && shownIdx !== null && shownIdx < entries.length ? entries[shownIdx]! : null;
  // 当前题视图必须信任 props（frozen/currentTask）：作答后 invalidate refetch 落地时
  // 批量 entries 已指向新的当前题，取 entry.task 会渲染"新题卡 + 旧题反馈"错配，
  // 坏题等操作也会 mutate 到错误的 taskId
  const shownTask = isCurrent
    ? (usableOptimistic?.task ?? frozen?.task ?? currentTask ?? entry?.task)
    : (entry?.task ?? frozen?.task ?? currentTask);
  const shownResult = isCurrent
    ? (usableOptimistic ? null : (frozen?.result ?? null))
    : (entry?.result ?? null);
  // 回看（列表只点已完成条目或"当前"）：cursor 只指向已完成条目
  const reviewing = cursor !== null;

  // 切到某词（到达/回看/回当前）自动读一次；关闭时不读。
  // 依赖 taskId 而非对象：只在换卡时读，不随 refetch（对象身份变化）或 result 变化重读
  useEffect(() => {
    if (!autoSpeak || !shownTask) return;
    void speak(shownTask.item.target);
  }, [shownTask?.taskId, autoSpeak]);

  return (
    <div className="space-y-4">
      <ProgressRow
        progress={progress}
        entries={entries}
        currentIdx={displayIdx}
        shownIdx={shownIdx}
        autoSpeak={autoSpeak}
        onToggleAutoSpeak={() => {
          setAutoSpeak((v) => {
            const next = !v;
            localStorage.setItem('el:auto-pronounce', next ? '1' : '0');
            return next;
          });
        }}
        onJump={(i) => setCursor(i)}
      />

      {shownTask && !optimisticHold ? (
        <TaskCard
          key={shownTask.taskId}
          task={shownTask}
          result={shownResult}
          readOnly={reviewing}
          onAnswered={reviewing ? undefined : (result, opts) => handleAnswered(shownTask, result, opts)}
          onAdvance={reviewing ? () => setCursor(null) : onAdvance}
        />
      ) : (
        <p className="py-16 text-center text-sm text-muted-foreground">正在加载下一题…</p>
      )}
    </div>
  );
}
