import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from '../lib/utils';
import { splitClozeBlank } from '../lib/questions';
import type { QuestionAnswerResult } from './question-answer';

export interface ClozeQuestionData {
  questionId: string;
  textWithBlank: string;
}

interface ClozeQuestionCardProps {
  question: ClozeQuestionData;
  result: QuestionAnswerResult | null;
  pending: boolean;
  /** 提交填空答案（viewedSource 由本组件跟踪） */
  onSubmitText: (text: string, meta: { viewedSource: boolean }) => void;
  onAdvance: () => void;
  /** 提供时展示“查看原句”，答错自动揭示（Today 传 source example；练习不传） */
  sourceExample?: string | null;
}

/** 填空题：空位内嵌输入，对错均手动下一题（PRODUCT §7.2/§7.6）；Today 与练一下共用 */
export function ClozeQuestionCard({
  question,
  result,
  pending,
  onSubmitText,
  onAdvance,
  sourceExample = null,
}: ClozeQuestionCardProps) {
  const [text, setText] = useState('');
  const [viewedSource, setViewedSource] = useState(false);

  const phase = result ? (result.correct ? 'correct' : 'wrong') : 'answering';
  const [before, after] = splitClozeBlank(question.textWithBlank);
  const showSource = (viewedSource || phase === 'wrong') && sourceExample !== null;

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmitText(trimmed, { viewedSource });
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
            disabled={pending}
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
          {sourceExample !== null && !viewedSource && (
            <Button variant="ghost" size="sm" onClick={() => setViewedSource(true)}>
              查看原句
            </Button>
          )}
          <Button disabled={!text.trim() || pending} onClick={submit}>
            提交
          </Button>
        </div>
      )}

      {showSource && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">原句</span>
          {sourceExample}
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
