import { useState } from 'react';
import type { AnswerResponse, TodayTaskView } from '@el/shared';
import { ThumbsDown } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { useBadQuestion } from '../api';
import { ChoiceQuestionView } from './ChoiceQuestionView';
import { ClozeQuestionView } from './ClozeQuestionView';
import { ProductionQuestionView } from './ProductionQuestionView';
import { RecallCard } from './RecallCard';

interface Props {
  task: TodayTaskView;
  /** 已作答时冻结的任务 + 结果（用于展示反馈，直到 advance） */
  result: AnswerResponse | null;
  /** 回看模式：禁用答题交互，仅展示冻结结果 */
  readOnly?: boolean;
  onAnswered?: (result: AnswerResponse, opts?: { autoAdvance?: boolean }) => void;
  onAdvance?: () => void;
}

/** 单张任务卡：按题型渲染题目；右上操作（稍后再做 / 坏题） */
export function TaskCard({ task, result, readOnly, onAnswered, onAdvance }: Props) {
  const badQuestion = useBadQuestion();
  const [confirmBad, setConfirmBad] = useState(false);

  const question = task.question;

  function closeBadConfirm() {
    setConfirmBad(false);
  }

  return (
    <article className="relative rounded-xl border border-border bg-card p-5 pt-4">
      {/* 右上角操作：绝对定位，与词行同高（词行 pr-12 让位） */}
      <div className="absolute right-3 top-3 z-10">
        {result && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmBad(true)}
          >
            <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
            坏题
          </Button>
        )}
      </div>

      {/* 回看/已答：顶部显示考的单词（learn/understanding 由 RecallCard 自带词行，不重复） */}
      {(result !== null || readOnly) && task.taskType !== 'learn' && task.taskType !== 'understanding' && (
        <div className="mb-3 flex items-baseline gap-2 pr-12">
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
            readOnly={readOnly}
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

      {confirmBad && (
        <div
          role="dialog"
          aria-label="标记坏题"
          className="mt-4 space-y-3 rounded-lg border border-border p-4"
        >
          <div className="space-y-1">
            <p className="text-sm text-foreground">标记坏题</p>
            <p className="text-xs text-muted-foreground">标记坏题将撤销本次作答影响</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={closeBadConfirm}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={badQuestion.isPending}
              onClick={() =>
                badQuestion.mutate(task.taskId, {
                  onSuccess: () => {
                    closeBadConfirm();
                    onAdvance?.();
                  },
                })
              }
            >
              确定
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
