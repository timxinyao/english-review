import { useMemo, useState, type MouseEvent } from 'react';
import type {
  AnswerResponse,
  ChoiceQuestionView as ChoiceQuestion,
  TodayTaskView,
} from '@el/shared';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils';
import { useAnswer, useTaskFeedback } from '../api';
import { shuffled } from '../utils';

interface Props {
  task: TodayTaskView;
  question: ChoiceQuestion;
  /** 冻结的作答结果（null = 尚未作答） */
  result: AnswerResponse | null;
  onAnswered: (result: AnswerResponse) => void;
  onAdvance: () => void;
}

/** 理解题（含 Learn 卡首题）：PRODUCT §7.1/§7.6 */
export function ChoiceQuestionView({ task, question, result, onAnswered, onAdvance }: Props) {
  const answer = useAnswer();
  const feedback = useTaskFeedback();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewedSource, setViewedSource] = useState(false);

  // 前端 shuffle：同一 questionId 顺序稳定（useMemo 缓存），提交的仍是原 option id
  const options = useMemo(
    () => shuffled(question.options, question.questionId),
    [question.options, question.questionId],
  );

  const phase = result ? (result.correct ? 'correct' : 'wrong') : 'answering';
  // learn 卡已直接展示原句，无需“查看原句”，答错也不重复揭示
  const canRevealSource = task.taskType !== 'learn' && !!task.sourceExample;
  const showSource = canRevealSource && (viewedSource || phase === 'wrong');
  const correctText = question.options.find((o) => o.id === result?.correctOptionId)?.text;

  function submit(optionId: string) {
    setSelectedId(optionId);
    answer.mutate(
      {
        taskId: task.taskId,
        body: {
          selectedOptionId: optionId,
          ...(viewedSource ? { viewedSource: true } : {}),
        },
      },
      { onSuccess: onAnswered },
    );
  }

  function sendFeedback(kind: 'guessed' | 'too_easy', e: MouseEvent) {
    e.stopPropagation(); // 不触发“点击任意处继续”
    feedback.mutate({ taskId: task.taskId, feedback: kind }, { onSuccess: onAdvance });
  }

  return (
    <div
      className="space-y-4"
      /* 答对后点击任意处立即继续（PRODUCT §7.6），反馈按钮通过 stopPropagation 例外 */
      onClick={phase === 'correct' ? onAdvance : undefined}
    >
      {question.context && (
        <p className="text-sm italic text-muted-foreground">{question.context}</p>
      )}
      <p className="text-base text-foreground">{question.question}</p>

      <div role="group" aria-label="选项" className="space-y-2">
        {options.map((option) => {
          const isChosen = selectedId === option.id;
          const isCorrect = result?.correct ? isChosen : result?.correctOptionId === option.id;
          return (
            <Button
              key={option.id}
              variant="outline"
              aria-pressed={isChosen}
              disabled={answer.isPending || phase !== 'answering'}
              className={cn(
                'w-full justify-start text-left',
                isChosen && phase === 'wrong' && 'border-destructive text-destructive',
                isCorrect && 'border-success text-success',
              )}
              onClick={() => submit(option.id)}
            >
              {option.text}
            </Button>
          );
        })}
      </div>

      {phase === 'answering' && canRevealSource && !viewedSource && (
        <Button variant="ghost" size="sm" onClick={() => setViewedSource(true)}>
          查看原句
        </Button>
      )}
      {showSource && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">原句</span>
          {task.sourceExample}
        </p>
      )}

      {phase === 'correct' && (
        <div className="space-y-3">
          <p className="text-sm text-success">回答正确</p>
          <div className="flex gap-4">
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={(e) => sendFeedback('guessed', e)}
            >
              其实我蒙的
            </button>
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={(e) => sendFeedback('too_easy', e)}
            >
              太简单了
            </button>
          </div>
        </div>
      )}

      {phase === 'wrong' && (
        <div className="space-y-3">
          <p className="text-sm text-destructive">回答错误</p>
          {result?.correctOptionId && (
            <p className="text-sm">
              <span className="text-muted-foreground">正确答案：</span>
              <span className="text-success">{correctText}</span>
            </p>
          )}
          {result?.explanation && (
            <p className="text-sm text-muted-foreground">{result.explanation}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={(e) => sendFeedback('guessed', e)}
            >
              其实我蒙的
            </button>
            <Button onClick={onAdvance}>下一题</Button>
          </div>
        </div>
      )}
    </div>
  );
}
