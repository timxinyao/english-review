import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerResponse, TodayProgress, TodayTaskView } from '@el/shared';
import { CORRECT_AUTO_ADVANCE_MS } from '../../../lib/questions';
import { cn } from '../../../lib/utils';
import { TaskCard } from './TaskCard';

/** 答对后的自动下一题延迟（PRODUCT §7.6：约 2 秒，点击任意处立即继续） */
export { CORRECT_AUTO_ADVANCE_MS };

/** 手动下一题的题型（PRODUCT §7.6：填空与表达题）；learn/理解题（选择题）答对自动下一题 */
const MANUAL_ADVANCE_TYPES: ReadonlySet<TodayTaskView['taskType']> = new Set([
  'cloze',
  'production',
]);

/** 冻结的作答反馈：任务 + 结果，advance 前一直展示（含最后一题答完会话已完成的情况） */
export interface FrozenAnswer {
  task: TodayTaskView;
  result: AnswerResponse;
}

function ProgressRow({ completed, total }: { completed: number; total: number }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        {completed} / {total}
      </p>
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

/** active 态：细进度行 + 当前任务卡；作答后冻结卡片展示反馈，advance 再进入下一题 */
export function ActiveSession({
  progress,
  currentTask,
  frozen,
  onAnswered,
  onAdvance,
}: ActiveSessionProps) {
  const [hold, setHold] = useState(false);
  // 已结算任务 id：refetch 未落地时避免旧任务卡重复出现/重复作答
  const answeredTaskIds = useRef<Set<string>>(new Set());

  const handleHoldChange = useCallback((next: boolean) => setHold(next), []);

  const handleAnswered = useCallback(
    (task: TodayTaskView, result: AnswerResponse) => {
      answeredTaskIds.current.add(task.taskId);
      onAnswered({ task, result });
    },
    [onAnswered],
  );

  // 选择题答对：约 2 秒后自动下一题（填空/表达题手动下一题；confirm 弹窗期间 hold 暂停）
  useEffect(() => {
    if (!frozen || !frozen.result.correct || MANUAL_ADVANCE_TYPES.has(frozen.task.taskType) || hold)
      return;
    const timer = setTimeout(onAdvance, CORRECT_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [frozen, hold, onAdvance]);

  // 反馈展示期间冻结已答任务；advance 后显示 refetch 到的下一个任务，
  // 已结算但 refetch 未落地时显示加载占位而非旧任务卡。
  const nextTask =
    currentTask && !answeredTaskIds.current.has(currentTask.taskId) ? currentTask : null;
  const shownTask = frozen?.task ?? nextTask;

  return (
    <div className="space-y-4">
      {progress && <ProgressRow completed={progress.completed} total={progress.total} />}

      {shownTask ? (
        <TaskCard
          key={shownTask.taskId}
          task={shownTask}
          result={frozen?.result ?? null}
          onAnswered={(result) => handleAnswered(shownTask, result)}
          onAdvance={onAdvance}
          onHoldChange={handleHoldChange}
        />
      ) : (
        <p className="py-16 text-center text-sm text-muted-foreground">正在加载下一题…</p>
      )}
    </div>
  );
}
