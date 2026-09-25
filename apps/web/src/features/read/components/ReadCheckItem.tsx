import { useState } from 'react';
import type { ReadCheckResponse, ReadCheckView } from '@el/shared';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils';
import { useCheckAnswer } from '../api';

/**
 * Read 检查题（PRODUCT §8.1/§8.2）：radio 选择 + [提交]，每题只可提交一次。
 * 不 shuffle（非缓存题）；答错显示正确选项与补强提示，不改变 Stage。
 */
export function ReadCheckItem({
  articleId,
  check,
  index,
}: {
  articleId: string;
  check: ReadCheckView;
  index: number;
}) {
  const answer = useCheckAnswer(articleId);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<ReadCheckResponse | null>(null);

  const locked = result !== null;
  const correctText = check.options.find((o) => o.id === result?.correctOptionId)?.text;

  function submit() {
    if (selected === null || locked) return;
    answer.mutate({ checkId: check.checkId, selectedOptionId: selected }, { onSuccess: setResult });
  }

  return (
    <fieldset className="m-0 space-y-3 border-0 p-0">
      <legend className="sr-only">检查题 {index + 1}</legend>
      <p className="text-sm text-foreground">{check.question}</p>

      <div className="space-y-1.5">
        {check.options.map((option) => {
          const isChosen = selected === option.id;
          const isCorrectOption = locked && result?.correctOptionId === option.id;
          const isWrongChoice = locked && isChosen && result !== null && !result.correct;
          return (
            <label
              key={option.id}
              className={cn(
                'flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm transition-colors',
                locked ? 'cursor-default' : 'cursor-pointer hover:bg-muted',
                isChosen && !locked && 'border-accent bg-accent-soft',
                isCorrectOption && 'border-success text-success',
                isWrongChoice && 'border-destructive text-destructive',
              )}
            >
              <input
                type="radio"
                name={`read-check-${check.checkId}`}
                value={option.id}
                checked={isChosen}
                disabled={locked || answer.isPending}
                onChange={() => setSelected(option.id)}
                className="h-4 w-4 accent-accent"
              />
              <span>{option.text}</span>
            </label>
          );
        })}
      </div>

      {!locked && (
        <Button size="sm" disabled={selected === null || answer.isPending} onClick={submit}>
          提交
        </Button>
      )}

      {result && (
        <div className="space-y-1">
          {result.correct ? (
            <p className="text-sm text-success">答对了</p>
          ) : (
            <>
              <p className="text-sm text-destructive">答错了</p>
              {correctText && (
                <p className="text-sm">
                  <span className="text-muted-foreground">正确选项：</span>
                  <span className="text-success">{correctText}</span>
                </p>
              )}
              {result.needsReinforcementMarked && (
                <p className="text-sm text-muted-foreground">下次 Today 会安排一题复习</p>
              )}
            </>
          )}
        </div>
      )}
    </fieldset>
  );
}
