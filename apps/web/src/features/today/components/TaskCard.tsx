import { useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AnswerResponse, TodayTaskView } from '@el/shared';
import { ChoiceQuestionView } from './ChoiceQuestionView';
import { ClozeQuestionView } from './ClozeQuestionView';
import { ProductionQuestionView } from './ProductionQuestionView';
import { RecallCard } from './RecallCard';
import { Button } from '../../../components/ui/button';
import { todayKeys, useLater, usePrepareTask } from '../api';

function PendingQuestion({ taskId }: { taskId: string }) {
  const prepare = usePrepareTask();
  const later = useLater();
  const queryClient = useQueryClient();
  const started = useRef(false);
  const { mutate } = prepare;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate(taskId);
  }, [taskId, mutate]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm text-muted-foreground">
          {prepare.isError ? prepare.error.message : '正在准备…'}
        </p>
      </div>
      {later.isError && (
        <p role="alert" className="text-sm text-destructive">
          {later.error.message}
        </p>
      )}
      <div className="flex shrink-0 gap-2" data-slot="dock">
        {prepare.isError && <Button onClick={() => mutate(taskId)}>重试</Button>}
        <Button variant="neutral" disabled={later.isPending} onClick={() => later.mutate(taskId)}>
          稍后再做
        </Button>
        {(prepare.isError || later.isError) && (
          <Button
            variant="ghost"
            onClick={() => void queryClient.invalidateQueries({ queryKey: todayKeys.all })}
          >
            刷新今日学习
          </Button>
        )}
      </div>
    </div>
  );
}

interface Props {
  task: TodayTaskView;
  /** 已作答时冻结的任务 + 结果（用于展示反馈，直到 advance） */
  result: AnswerResponse | null;
  /** 卡片右上角插槽：撤销最近一次作答的单图标（PRODUCT §5.1；无可撤销作答时不传入） */
  undoControl?: ReactNode;
  onAnswered?: (result: AnswerResponse, opts?: { autoAdvance?: boolean }) => void;
  onAdvance?: () => void;
}

/**
 * 单张任务卡：按题型渲染题目。坏题入口不在卡面——2026-09-28 起只在
 * 「今日学习」的具体作答记录上标记（PRODUCT §4.2/§6.5）；顺序回看已删除，
 * 历史作答一律进只读弹层。卡片右上角为撤销最近一次作答的单图标（区别于坏题）。
 */
export function TaskCard({ task, result, undoControl, onAnswered, onAdvance }: Props) {
  const question = task.question;

  return (
    <article className="relative flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card p-5 pt-4">
      {/* 右上角撤销图标：悬浮于卡角（答错冻结头行已留 pr-12 避让） */}
      {undoControl && <div className="absolute right-2 top-2 z-10">{undoControl}</div>}
      {/* 已答冻结：顶部显示考的单词（learn/understanding 由 RecallCard 自带词行，不重复） */}
      {result !== null && task.taskType !== 'learn' && task.taskType !== 'understanding' && (
        <div className="mb-3 flex shrink-0 items-baseline gap-2 pr-12">
          <h3 className="text-lg font-semibold text-foreground">{task.item.target}</h3>
          {task.item.type === 'word' && task.item.ipa !== null && (
            <span className="text-sm text-muted-foreground">{task.item.ipa}</span>
          )}
        </div>
      )}

      {/* 理解题（learn 新词 + understanding 复习）：Recall Card——主动回忆优先，直判/显示答案两条路 */}
      {!question ? (
        <PendingQuestion taskId={task.taskId} />
      ) : 'options' in question ? (
        task.taskType === 'understanding' || task.taskType === 'learn' ? (
          <RecallCard
            task={task}
            result={result}
            outcomeSource={result?.outcomeSource ?? null}
            onAnswered={onAnswered ?? (() => {})}
            onAdvance={onAdvance ?? (() => {})}
          />
        ) : (
          <ChoiceQuestionView
            task={task}
            question={question}
            result={result}
            onAnswered={onAnswered ?? (() => {})}
            onAdvance={onAdvance ?? (() => {})}
          />
        )
      ) : question && 'textWithBlank' in question ? (
        <ClozeQuestionView
          task={task}
          question={question}
          result={result}
          onAnswered={onAnswered ?? (() => {})}
          onAdvance={onAdvance ?? (() => {})}
        />
      ) : question && 'zhPrompt' in question ? (
        <ProductionQuestionView
          task={task}
          question={question}
          result={result}
          onAnswered={onAnswered ?? (() => {})}
          onAdvance={onAdvance ?? (() => {})}
        />
      ) : null}
    </article>
  );
}
