import type { ReactNode } from 'react';
import type { AnswerResponse, TodayTaskView } from '@el/shared';
import { ChoiceQuestionView } from './ChoiceQuestionView';
import { ClozeQuestionView } from './ClozeQuestionView';
import { ProductionQuestionView } from './ProductionQuestionView';
import { RecallCard } from './RecallCard';

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

      {/* 理解题（learn 新词 + understanding 复习）：Recall Card——主动回忆优先，选择题降级为 Hint */}
      {question && 'options' in question ? (
        task.taskType === 'understanding' || task.taskType === 'learn' ? (
          <RecallCard
            task={task}
            question={question}
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
