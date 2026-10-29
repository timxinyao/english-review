import { useEffect, useRef, useState } from 'react';
import { Check, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { haptic } from '../lib/haptics';
import {
  PRODUCTION_VERDICTS,
  SCRAMBLE_GUIDANCE,
  type QuestionAnswerResult,
} from './question-answer';

export interface ScrambleQuestionData {
  questionId: string;
  kind: 'scramble';
  zhPrompt: string;
  targets: Array<{ learningItemId: string; surface: string }>;
  chips: string[];
}
interface ScrambleQuestionCardProps {
  question: ScrambleQuestionData;
  result: QuestionAnswerResult | null;
  pending: boolean;
  error: string | null;
  onSubmitTokens: (tokens: string[]) => void;
  onGiveUp?: () => void;
  onAdvance: () => void;
  variant?: 'today';
}
/** Stable chip identities preserve duplicate words and prevent the bank jumping under a finger. */
export function ScrambleQuestionCard({
  question,
  result,
  pending,
  error,
  onSubmitTokens,
  onGiveUp,
  onAdvance,
  variant,
}: ScrambleQuestionCardProps) {
  const [selected, setSelected] = useState<number[]>([]);
  const submitting = useRef(false);
  useEffect(() => {
    setSelected([]);
    submitting.current = false;
  }, [question.questionId]);
  useEffect(() => {
    if (!pending || error) submitting.current = false;
  }, [pending, error]);
  const locked = !!result || pending;
  const reference = result?.referenceTokens?.join(' ') || result?.referenceAnswer || null;
  function pick(index: number) {
    if (locked || submitting.current) return;
    haptic('selection');
    setSelected((previous) => (previous.includes(index) ? previous : [...previous, index]));
  }
  function remove(index: number) {
    if (locked || submitting.current) return;
    haptic('selection');
    setSelected((previous) => previous.filter((_, position) => position !== index));
  }
  function submit(giveUp = false) {
    if (locked || submitting.current || (!giveUp && !selected.length)) return;
    submitting.current = true;
    haptic('confirm');
    if (giveUp) onGiveUp?.();
    else onSubmitTokens(selected.map((index) => question.chips[index]!));
  }
  return (
    <div className={cn('flex min-w-0 flex-col', variant === 'today' && 'min-h-0 flex-1')}>
      <div
        className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1"
        data-slot="body"
      >
        <div className="space-y-3">
          <p className="text-xl leading-relaxed font-medium text-foreground">{question.zhPrompt}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1" aria-label="本题目标">
            {question.targets.map((target) => (
              <span key={target.learningItemId} className="text-sm font-medium text-accent">
                {target.surface}
              </span>
            ))}
          </div>
        </div>
        {!result && (
          <>
            <div
              className="scramble-answer"
              data-testid="scramble-answer-row"
              aria-label="你的句子"
            >
              {selected.length === 0 ? (
                <p className="py-3 text-sm leading-6 text-muted-foreground">
                  点选下方词芯片组成句子
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {selected.map((index, position) => (
                    <button
                      key={index}
                      type="button"
                      disabled={locked}
                      className="word-chip word-chip-selected"
                      aria-label={`移除 ${question.chips[index]}，第 ${position + 1} 个词`}
                      onClick={() => remove(position)}
                    >
                      {question.chips[index]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={locked || !selected.length}
                aria-label="撤回最后一个词"
                onClick={() => remove(selected.length - 1)}
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                撤回
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={locked || !selected.length}
                aria-label="清空句子"
                onClick={() => {
                  if (!submitting.current) {
                    haptic('selection');
                    setSelected([]);
                  }
                }}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                清空
              </Button>
            </div>
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-xs leading-5 text-muted-foreground">
                点选词语组句，再点已选词可移除
              </p>
              <div
                className="flex flex-wrap gap-2"
                data-testid="scramble-chip-bank"
                aria-label="可用词语"
              >
                {question.chips.map((token, index) => (
                  <button
                    key={`${question.questionId}-${index}`}
                    type="button"
                    disabled={locked || selected.includes(index)}
                    aria-pressed={selected.includes(index)}
                    className={cn('word-chip', selected.includes(index) && 'word-chip-used')}
                    onClick={() => pick(index)}
                  >
                    {token}
                  </button>
                ))}
              </div>
            </div>
            <span className="sr-only" role="status" aria-live="polite">
              已选 {selected.length} 个词
            </span>
          </>
        )}
        {result && (
          <div className="reveal-in space-y-4" data-testid="scramble-result" role="status">
            <p
              className={cn(
                'flex items-center gap-2 text-base font-semibold',
                PRODUCTION_VERDICTS[result.result].className,
              )}
            >
              {result.result === 'pass' && <Check className="h-5 w-5" aria-hidden />}
              {PRODUCTION_VERDICTS[result.result].label}
            </p>
            {result.submittedAnswerText && (
              <div className="study-example">
                <p className="text-xs text-muted-foreground">你的句子</p>
                <p className="mt-1 break-words text-base leading-7">{result.submittedAnswerText}</p>
              </div>
            )}
            {result.itemResults?.length ? (
              <ul className="divide-y divide-border">
                {result.itemResults.map((item) => (
                  <li
                    key={item.learningItemId}
                    className="flex items-center justify-between gap-4 py-2.5 text-sm"
                  >
                    <span>{item.surface}</span>
                    <span
                      className={
                        item.result === 'pass'
                          ? 'text-success'
                          : item.result === 'basic_pass'
                            ? 'text-warning'
                            : 'text-destructive'
                      }
                    >
                      {item.result === 'pass'
                        ? '对'
                        : item.result === 'basic_pass'
                          ? '基本正确'
                          : '错'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {reference && (
              <div className="study-example">
                <p className="text-sm leading-7">
                  <span className="text-muted-foreground">参考：</span>
                  {reference}
                </p>
              </div>
            )}
            <p className="text-sm leading-7 text-muted-foreground">{SCRAMBLE_GUIDANCE}</p>
          </div>
        )}
      </div>
      <div
        className={cn('study-dock grid gap-2', !result && onGiveUp && 'grid-cols-[2fr_1fr]')}
        data-slot="dock"
      >
        {error && (
          <p
            role="alert"
            className="col-span-full rounded-lg bg-destructive-soft p-3 text-sm leading-6 text-destructive"
          >
            {error}
          </p>
        )}

        {result ? (
          <Button type="button" className="w-full" onClick={onAdvance}>
            继续
          </Button>
        ) : (
          <>
            <Button
              type="button"
              className="w-full"
              disabled={pending || !selected.length}
              onClick={() => submit()}
            >
              {pending ? '提交中…' : '提交'}
            </Button>
            {onGiveUp && (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={pending}
                onClick={() => submit(true)}
              >
                不会
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
