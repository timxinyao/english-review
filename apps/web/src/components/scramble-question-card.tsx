import { useMemo, useState } from 'react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { PRODUCTION_VERDICTS, type QuestionAnswerResult } from './question-answer';

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

/**
 * 拼词表达题（scramble_v1）：中文题干 + 词芯片点选组句。
 * 不预展示参考句；提交后由 result.referenceTokens / itemResults 揭示。
 */
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
  const [selected, setSelected] = useState<string[]>([]);
  /** 剩余筹码：按初始 chips 多重集减去已选（同词可多次出现时按出现次数扣） */
  const remaining = useMemo(() => {
    const bag = new Map<string, number>();
    for (const c of question.chips) bag.set(c, (bag.get(c) ?? 0) + 1);
    for (const s of selected) bag.set(s, (bag.get(s) ?? 0) - 1);
    const out: string[] = [];
    for (const c of question.chips) {
      const n = bag.get(c) ?? 0;
      if (n > 0) {
        out.push(c);
        bag.set(c, n - 1);
      }
    }
    return out;
  }, [question.chips, selected]);

  const locked = !!result || pending;

  function pick(token: string) {
    if (locked) return;
    setSelected((prev) => [...prev, token]);
  }

  function unpick(index: number) {
    if (locked) return;
    setSelected((prev) => prev.filter((_, i) => i !== index));
  }

  const referenceReveal =
    result?.referenceTokens && result.referenceTokens.length > 0
      ? result.referenceTokens.join(' ')
      : result?.referenceAnswer ?? null;

  return (
    <div className={cn('flex flex-col gap-4', variant === 'today' && 'min-h-0')}>
      <p className="text-base leading-relaxed text-foreground">{question.zhPrompt}</p>

      <div className="flex flex-wrap gap-2">
        {question.targets.map((t) => (
          <span
            key={t.learningItemId}
            className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"
          >
            {t.surface}
          </span>
        ))}
      </div>

      <div
        className="min-h-12 rounded-lg border border-dashed border-border bg-muted/30 p-2"
        data-testid="scramble-answer-row"
      >
        {selected.length === 0 ? (
          <span className="text-sm text-muted-foreground">点选下方词芯片组成句子</span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {selected.map((tok, i) => (
              <button
                key={`${tok}-${i}`}
                type="button"
                disabled={locked}
                className="rounded-md bg-primary/10 px-2.5 py-1.5 text-sm text-foreground"
                onClick={() => unpick(i)}
              >
                {tok}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2" data-testid="scramble-chip-bank">
        {remaining.map((tok, i) => (
          <button
            key={`${tok}-bank-${i}`}
            type="button"
            disabled={locked}
            className="rounded-md border border-border bg-card px-2.5 py-1.5 text-sm shadow-sm"
            onClick={() => pick(tok)}
          >
            {tok}
          </button>
        ))}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {result ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="scramble-result">
          <p className={cn('text-sm font-medium', PRODUCTION_VERDICTS[result.result].className)}>
            {PRODUCTION_VERDICTS[result.result].label}
          </p>
          {result.itemResults && result.itemResults.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {result.itemResults.map((ir) => (
                <li key={ir.learningItemId} className="flex justify-between gap-2">
                  <span>{ir.surface}</span>
                  <span className={ir.result === 'pass' ? 'text-success' : 'text-destructive'}>
                    {ir.result === 'pass' ? '对' : '错'}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {referenceReveal ? (
            <p className="text-sm text-muted-foreground">参考：{referenceReveal}</p>
          ) : null}
          {result.explanation ? <p className="text-sm text-muted-foreground">{result.explanation}</p> : null}
          <Button type="button" onClick={onAdvance}>
            继续
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={pending || selected.length === 0}
            onClick={() => onSubmitTokens(selected)}
          >
            {pending ? '提交中…' : '提交'}
          </Button>
          {onGiveUp ? (
            <Button type="button" variant="ghost" disabled={pending} onClick={onGiveUp}>
              不会
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
