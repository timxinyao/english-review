import { useState } from 'react';
import type { AnswerResponse, TodayTaskView } from '@el/shared';
import { Clock, ThumbsDown } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { useBadQuestion, useLater } from '../api';
import { ChoiceQuestionView } from './ChoiceQuestionView';
import { ClozeQuestionView } from './ClozeQuestionView';
import { LearnContent } from './LearnContent';
import { ProductionQuestionView } from './ProductionQuestionView';

interface Props {
  task: TodayTaskView;
  /** 已作答时冻结的任务 + 结果（用于展示反馈，直到 advance） */
  result: AnswerResponse | null;
  onAnswered: (result: AnswerResponse) => void;
  onAdvance: () => void;
  /** 打开/关闭确认框时暂停“答对 2 秒自动下一题” */
  onHoldChange: (hold: boolean) => void;
}

/** 单张任务卡：learn 内容 + 按题型渲染题目；右上操作（稍后再做 / 坏题） */
export function TaskCard({ task, result, onAnswered, onAdvance, onHoldChange }: Props) {
  const later = useLater();
  const badQuestion = useBadQuestion();
  const [confirmBad, setConfirmBad] = useState(false);

  const question = task.question;

  function closeBadConfirm() {
    setConfirmBad(false);
    onHoldChange(false);
  }

  return (
    <article className="relative rounded-xl border border-border bg-card p-5 pt-4">
      {/* 右上角操作：绝对定位，与词行同高（LearnContent 词行 pr-12 让位） */}
      <div className="absolute right-3 top-3 z-10">
        {!result && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground"
            aria-label="稍后再做"
            title="稍后再做"
            disabled={later.isPending}
            onClick={() => later.mutate(task.taskId)}
          >
            <Clock className="h-4 w-4" aria-hidden />
          </Button>
        )}
        {result && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfirmBad(true);
              onHoldChange(true);
            }}
          >
            <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
            坏题
          </Button>
        )}
      </div>

      {task.taskType === 'learn' && <LearnContent task={task} />}

      {question && 'options' in question ? (
        <ChoiceQuestionView
          task={task}
          question={question}
          result={result}
          onAnswered={onAnswered}
          onAdvance={onAdvance}
        />
      ) : question && 'textWithBlank' in question ? (
        <ClozeQuestionView
          task={task}
          question={question}
          result={result}
          onAnswered={onAnswered}
          onAdvance={onAdvance}
        />
      ) : question && 'zhPrompt' in question ? (
        <ProductionQuestionView
          task={task}
          question={question}
          result={result}
          onAnswered={onAnswered}
          onAdvance={onAdvance}
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
                    onAdvance();
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
