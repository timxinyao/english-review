import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AnswerResponse, SessionTaskEntry, TodayProgress, TodayTaskView } from '@el/shared';
import { Volume2, VolumeX } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { speak } from '../../../lib/tts';
import { TaskCard } from './TaskCard';
import { TodayLearningSheet } from './TodayLearningSheet';
import { UndoAnswerControl } from './UndoAnswer';
import { useSessionTasks } from '../api';

export interface FrozenAnswer {
  task: TodayTaskView;
  result: AnswerResponse;
  autoAdvance?: boolean;
}

/** 进度分段颜色：pass 绿 / basic_pass 黄 / fail 红 / 未完成灰（PRODUCT §5.1/§9 少颜色） */
const SEG_CLASS: Record<'pass' | 'basic_pass' | 'fail' | 'pending', string> = {
  pass: 'bg-success',
  basic_pass: 'bg-warning',
  fail: 'bg-destructive',
  pending: 'bg-muted',
};

/**
 * 进度行：已完成数/总数 + 四色结果分布 + 文字计数（不只靠颜色）；
 * 点击打开「今日学习」只读弹层——不用于跳题/回看/重答（PRODUCT §5.1）。
 * 计数仅由 GET /api/today/tasks 派生：已撤销条目整体排除（不进分母，Task 2 契约），
 * 补强动态插入时总题数随批量视图同步更新；批量视图未落地时用会话进度兜底。
 */
function ProgressRow({
  progress,
  entries,
  currentTaskId,
  autoSpeak,
  onToggleAutoSpeak,
}: {
  progress: TodayProgress | null;
  entries: SessionTaskEntry[] | null;
  currentTaskId: string | null;
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
}) {
  const [open, setOpen] = useState(false);
  const live = useMemo(() => (entries ?? []).filter((e) => !e.canceled), [entries]);
  const hasEntries = entries !== null && live.length > 0;
  const total = hasEntries ? live.length : (progress?.total ?? 0);
  const completed = hasEntries
    ? live.filter((e) => e.result !== null).length
    : (progress?.completed ?? 0);
  const pass = live.filter((e) => e.result?.result === 'pass').length;
  const basicPass = live.filter((e) => e.result?.result === 'basic_pass').length;
  const fail = live.filter((e) => e.result?.result === 'fail').length;

  return (
    <div className="shrink-0 space-y-1.5">
      {/* 音量开关与进度按钮为兄弟节点：button 内嵌 button 是非法嵌套
          （React validateDOMNesting 报错，且点击会冒泡误开弹层） */}
      <div className="flex w-full items-center justify-between gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => setOpen(true)}
          aria-label="查看今日学习"
        >
          <span className="flex w-full items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {completed} / {total}
            </span>
            <span className="text-xs text-muted-foreground/60">今日学习 ▾</span>
          </span>
          {hasEntries && (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              通过 {pass} · 基础通过 {basicPass} · 未通过 {fail}
            </span>
          )}
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
      {/* 分布分段按结果着色；当前题段加高亮（颜色之外另有文字计数） */}
      {hasEntries && (
        <div className="flex gap-0.5" aria-hidden>
          {live.map((e) => {
            const kind = e.result?.result ?? 'pending';
            const current = e.task.taskId === currentTaskId;
            return (
              <span
                key={e.task.taskId}
                data-seg={kind}
                data-current={current}
                className={cn('flex-1 rounded-full', current ? 'h-1.5' : 'h-1', SEG_CLASS[kind])}
              />
            );
          })}
        </div>
      )}

      {/* 弹层不改变当前题：只展示，关闭即回原卡 */}
      {open && entries !== null && (
        <TodayLearningSheet entries={entries} onClose={() => setOpen(false)} />
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
  /** 撤销成功回调（TodayPage 按撤销目标决定是否清冻结反馈；见 TodayPage.handleUndone） */
  onUndone?: (taskId: string) => void;
}

export function ActiveSession({
  progress,
  currentTask,
  frozen,
  advancing,
  onAnswered,
  onAdvance,
  onUndone,
}: ActiveSessionProps) {
  const { data: sessionTasks } = useSessionTasks();
  const entries = sessionTasks?.tasks ?? null;
  const undoableTaskId = sessionTasks?.undoableTaskId ?? null;
  /** 切卡自动读词（设备本地偏好）：缺省开，'0'=关 */
  const [autoSpeak, setAutoSpeak] = useState(
    () => localStorage.getItem('el:auto-pronounce') !== '0',
  );

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
      onAnswered({ task, result, autoAdvance: opts?.autoAdvance });
    },
    [onAnswered],
  );

  // 乐观直切（评分即前进）：状态刷新落地前，用预取队列直接渲染下一题——服务端补强
  // 至少插在当前题 3 位之后（TECHNICAL §7.2），紧跟下一题稳定；末题无 entry 回落占位。
  // 刷新落地 advance() 后 frozen 清空、currentTask 接管，同一 taskId 无感衔接；
  // 刷新失败（advancing=false）仍回落旧题反馈页人工兜底。
  const optimisticEntry =
    advancing && entries !== null && currentIdx !== null && currentIdx + 1 < entries.length
      ? entries[currentIdx + 1]!
      : null;
  const usableOptimistic =
    optimisticEntry && !optimisticEntry.canceled && optimisticEntry.result === null
      ? optimisticEntry
      : null;
  const fallbackEntry =
    entries !== null && currentIdx !== null && currentIdx < entries.length
      ? entries[currentIdx]!
      : null;
  // 当前题视图必须信任 props（frozen/currentTask）：作答后 invalidate refetch 落地时
  // 批量 entries 已指向新的当前题，取 entry.task 会渲染"新题卡 + 旧题反馈"错配
  const shownTask =
    usableOptimistic?.task ?? frozen?.task ?? currentTask ?? fallbackEntry?.task ?? null;
  const shownResult = usableOptimistic ? null : (frozen?.result ?? null);
  // 窗口内但无可乐观的下一题（末题/队列未就绪）：占位等待，不渲染旧题反馈页
  const optimisticHold = advancing === true && !usableOptimistic;

  // 到达当前题自动读一次；关闭时不读。
  // 依赖 taskId 而非对象：只在换卡时读，不随 refetch（对象身份变化）或 result 变化重读
  useEffect(() => {
    if (!autoSpeak || !shownTask) return;
    void speak(shownTask.item.target);
  }, [shownTask?.taskId, autoSpeak]);

  return (
    /* 沉浸式一题一屏（PRODUCT §5.1）：移动端占满顶栏/导航间可用高度（dvh，键盘收放自适应）；
       桌面保持自然高度的可读版式 */
    <div className="flex h-today-viewport min-h-0 flex-col md:h-auto">
      <ProgressRow
        progress={progress}
        entries={entries}
        currentTaskId={shownTask?.taskId ?? null}
        autoSpeak={autoSpeak}
        onToggleAutoSpeak={() => {
          setAutoSpeak((v) => {
            const next = !v;
            localStorage.setItem('el:auto-pronounce', next ? '1' : '0');
            return next;
          });
        }}
      />

      {shownTask && !optimisticHold ? (
        <TaskCard
          key={shownTask.taskId}
          task={shownTask}
          result={shownResult}
          undoControl={
            <UndoAnswerControl
              undoableTaskId={undoableTaskId}
              entries={entries}
              onUndone={onUndone}
            />
          }
          onAnswered={(result, opts) => handleAnswered(shownTask, result, opts)}
          onAdvance={onAdvance}
        />
      ) : (
        <p className="py-16 text-center text-sm text-muted-foreground">正在加载下一题…</p>
      )}
    </div>
  );
}
