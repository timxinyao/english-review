import { useState } from 'react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { CorrectionDiff } from './correction-diff';
import { PRODUCTION_VERDICTS, type QuestionAnswerResult } from './question-answer';

export interface ProductionQuestionData {
  questionId: string;
  zhPrompt: string;
  mustUse: string;
}

interface ProductionQuestionCardProps {
  question: ProductionQuestionData;
  result: QuestionAnswerResult | null;
  pending: boolean;
  /** 批改失败的可读信息（如 AI_PROVIDER_ERROR）；输入保留由组件自身状态保证 */
  error: string | null;
  onSubmitText: (text: string) => void;
  onAdvance: () => void;
}

const textareaClass =
  'flex w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

/** 表达题：受控中文提示 + 批改结果（PRODUCT §7.3/§7.4/§7.6）；Today 与练一下共用 */
export function ProductionQuestionCard({
  question,
  result,
  pending,
  error,
  onSubmitText,
  onAdvance,
}: ProductionQuestionCardProps) {
  const [text, setText] = useState('');

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    onSubmitText(trimmed);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">用英语表达</p>
        <p className="text-lg leading-relaxed text-foreground">{question.zhPrompt}</p>
        <p className="text-sm text-muted-foreground">
          必须使用：
          <span className="font-medium text-accent">{question.mustUse}</span>
        </p>
      </div>

      {!result && (
        <div className="space-y-2">
          <textarea
            aria-label="表达答案"
            rows={5}
            className={textareaClass}
            placeholder="Write your sentence in English…"
            value={text}
            disabled={pending}
            onChange={(e) => setText(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              批改失败：{error}
            </p>
          )}
          <div className="flex justify-end">
            <Button disabled={!text.trim() || pending} onClick={submit}>
              {pending ? '批改中…' : error ? '重试' : '提交'}
            </Button>
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-3">
          <p className={cn('text-sm font-medium', PRODUCTION_VERDICTS[result.result].className)}>
            {PRODUCTION_VERDICTS[result.result].label}
          </p>
          {result.correction && (
            <CorrectionDiff
              segments={result.correction.segments}
              correctedSentence={result.correction.correctedSentence}
              betterVersion={result.correction.betterVersion}
            />
          )}
          {result.explanation && (
            <p className="text-sm text-muted-foreground">{result.explanation}</p>
          )}
          {result.personalExampleSaved && (
            <p className="text-xs text-muted-foreground">已存入个人例句</p>
          )}
          {/* 表达题不自动下一题（PRODUCT §7.6） */}
          <div className="flex justify-end">
            <Button onClick={onAdvance}>下一题</Button>
          </div>
        </div>
      )}
    </div>
  );
}
