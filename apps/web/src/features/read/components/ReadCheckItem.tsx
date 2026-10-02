import type { ReadCheckView } from '@el/shared';
import { cn } from '../../../lib/utils';

/**
 * Read 检查题（V1 遗留，只读）：V2 起不再生成/作答检查题。
 * 已答题回放首答（选中项、答对/答错与当时已揭晓的正确选项）；未答题只展示题面，
 * 无提交入口；所有选项不可交互。
 */
export function ReadCheckItem({ check, index }: { check: ReadCheckView; index: number }) {
  const answered = check.answered;
  const correctText = answered
    ? check.options.find((o) => o.id === answered.correctOptionId)?.text
    : undefined;

  return (
    <fieldset className="m-0 space-y-3 border-0 p-0">
      <legend className="sr-only">检查题 {index + 1}</legend>
      <p className="text-sm text-foreground">{check.question}</p>

      <div className="space-y-1.5">
        {check.options.map((option) => {
          const isChosen = answered?.selectedOptionId === option.id;
          const isCorrectOption = answered !== null && answered.correctOptionId === option.id;
          const isWrongChoice = answered !== null && isChosen && !answered.correct;
          return (
            <label
              key={option.id}
              className={cn(
                'flex cursor-default items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm',
                isChosen && 'border-accent bg-accent-soft',
                isCorrectOption && 'border-success text-success',
                isWrongChoice && 'border-destructive text-destructive',
              )}
            >
              <input
                type="radio"
                name={`read-check-${check.checkId}`}
                value={option.id}
                checked={isChosen}
                disabled
                readOnly
                className="h-4 w-4 accent-accent"
              />
              <span>{option.text}</span>
            </label>
          );
        })}
      </div>

      {answered ? (
        <div className="space-y-1">
          {answered.correct ? (
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
            </>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">历史检查题，仅供查看</p>
      )}
    </fieldset>
  );
}
