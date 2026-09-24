import { useState } from 'react';
import type { AnswerResponse, ClozeQuestionView as ClozeQuestion, TodayTaskView } from '@el/shared';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { cn } from '../../../lib/utils';
import { useAnswer } from '../api';
import { splitClozeBlank } from '../utils';

interface Props {
  task: TodayTaskView;
  question: ClozeQuestion;
  result: AnswerResponse | null;
  onAnswered: (result: AnswerResponse) => void;
  onAdvance: () => void;
}

/** 填空题：空位内嵌输入；对错均手动下一题（PRODUCT §7.6） */
export function ClozeQuestionView({ task, question, result, onAnswered, onAdvance }: Props) {
  const answer = useAnswer();
  const [text, setText] = useState('');
  const [viewedSource, setViewedSource] = useState(false);

  const phase = result ? (result.correct ? 'correct' : 'wrong') : 'answering';
  const [before, after] = splitClozeBlank(question.textWithBlank);
  const showSource = (viewedSource || phase === 'wrong') && !!task.sourceExample;

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    answer.mutate(
      {
        taskId: task.taskId,
        body: {
          answerText: trimmed,
          ...(viewedSource ? { viewedSource: true } : {}),
        },
      },
      { onSuccess: onAnswered },
    );
  }

  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-base leading-relaxed text-foreground">
        <span>{before}</span>
        {phase === 'answering' ? (
          <Input
            autoFocus
            aria-label="填空答案"
            className="h-9 w-40"
            value={text}
            disabled={answer.isPending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        ) : (
          <span
            className={cn(
              'rounded border px-2 py-0.5 font-medium',
              result?.correct
                ? 'border-success text-success'
                : 'border-destructive text-destructive',
            )}
          >
            {text.trim()}
          </span>
        )}
        <span>{after}</span>
      </p>

      {phase === 'answering' && (
        <div className="space-y-3">
          {!viewedSource && task.sourceExample && (
            <Button variant="ghost" size="sm" onClick={() => setViewedSource(true)}>
              查看原句
            </Button>
          )}
          <Button disabled={!text.trim() || answer.isPending} onClick={submit}>
            提交
          </Button>
        </div>
      )}

      {showSource && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">原句</span>
          {task.sourceExample}
        </p>
      )}

      {result && (
        <div className="space-y-3">
          <p className={cn('text-sm', result.correct ? 'text-success' : 'text-destructive')}>
            {result.correct ? '回答正确' : '回答错误'}
          </p>
          {result.completeSentence && (
            <p className="text-sm text-foreground">{result.completeSentence}</p>
          )}
          {!result.correct && result.acceptedAnswer && (
            <p className="text-sm">
              <span className="text-muted-foreground">可接受答案：</span>
              {result.acceptedAnswer}
            </p>
          )}
          {!result.correct && result.explanation && (
            <p className="text-sm text-muted-foreground">{result.explanation}</p>
          )}
          <div className="flex justify-end">
            <Button onClick={onAdvance}>下一题</Button>
          </div>
        </div>
      )}
    </div>
  );
}
