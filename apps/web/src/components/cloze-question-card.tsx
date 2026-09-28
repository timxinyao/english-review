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
  /** 主动不会（Today 专用，§7.6）：缺省=练一下布局，不出该入口 */
  onGiveUp?: () => void;
  onAdvance: () => void;
  /** 提供时展示“查看原句”，答错自动揭示（Today 传 source example；练习不传） */
  sourceExample?: string | null;
  /** Today 沉浸式布局：题干/反馈滚动 + 输入/按钮停靠底部 dock（§5.1 键盘弹出仍可达） */
  variant?: 'today';
}

/** 填空题：对错均手动下一题（PRODUCT §7.2/§7.6）；Today 与练一下共用。
 *  冻结空位展示服务端回传的提交文本（回放成立），练一下无该字段时回落本地输入。 */
export function ClozeQuestionCard({
  question,
  result,
  pending,
  onSubmitText,
  onGiveUp,
  onAdvance,
  sourceExample = null,
  variant,
}: ClozeQuestionCardProps) {
  const [text, setText] = useState('');
  const [viewedSource, setViewedSource] = useState(false);

  const phase = result ? (result.correct ? 'correct' : 'wrong') : 'answering';
  const gaveUp = result?.gaveUp === true;
  const [before, after] = splitClozeBlank(question.textWithBlank);
  const showSource = (viewedSource || phase === 'wrong') && sourceExample !== null;
  const submittedText = result?.submittedAnswerText ?? (phase === 'answering' ? '' : text.trim());

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmitText(trimmed, { viewedSource });
  }

  const blank = (
    <>
      {phase === 'answering' ? (
        variant === 'today' ? (
          // 沉浸式：输入停靠底部 dock，句面只留空位标记
          <span aria-hidden className="mx-1 inline-block w-24 border-b border-input" />
        ) : (
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
        )
      ) : submittedText ? (
        <span
          className={cn(
            'rounded border px-2 py-0.5 font-medium',
            result?.correct ? 'border-success text-success' : 'border-destructive text-destructive',
          )}
        >
          {submittedText}
        </span>
      ) : (
        // 主动不会：无提交内容，空位保持中性标记
        <span aria-hidden className="mx-1 inline-block w-24 border-b border-input" />
      )}
    </>
  );

  const sentence = (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-base leading-relaxed text-foreground">
      <span>{before}</span>
      {blank}
      <span>{after}</span>
    </p>
  );

  const sourceBlock = showSource && (
    <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
      <span className="mr-1 text-xs text-muted-foreground">原句</span>
      {sourceExample}
    </p>
  );

  const feedback =
    result !== null && (
      <div className="space-y-3">
        <p
          className={cn(
            'text-sm',
            result.correct ? 'text-success' : 'text-destructive',
          )}
        >
          {result.correct ? '回答正确' : gaveUp ? '主动不会' : '回答错误'}
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
      </div>
    );

  if (variant === 'today') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto" data-slot="body">
          {sentence}
          {sourceBlock}
          {feedback}
        </div>
        {phase === 'answering' ? (
          <div className="mt-3 shrink-0 space-y-2 border-t border-border pt-3" data-slot="dock">
            <Input
              autoFocus
              aria-label="填空答案"
              className="h-10 w-full"
              value={text}
              disabled={pending}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
            <div className="flex items-center justify-between gap-2">
              {sourceExample !== null && !viewedSource ? (
                <Button variant="ghost" size="sm" onClick={() => setViewedSource(true)}>
                  查看原句
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                {onGiveUp && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    disabled={pending}
                    onClick={onGiveUp}
                  >
                    不会填
                  </Button>
                )}
                <Button disabled={!text.trim() || pending} onClick={submit}>
                  提交
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div
            className="mt-3 flex shrink-0 justify-end border-t border-border pt-3"
            data-slot="dock"
          >
            <Button onClick={onAdvance}>下一题</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sentence}

      {phase === 'answering' && (
        <div className="space-y-3">
          {sourceExample !== null && !viewedSource && (
            <Button variant="ghost" size="sm" onClick={() => setViewedSource(true)}>
              查看原句
            </Button>
          )}
          {onGiveUp && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={pending}
              onClick={onGiveUp}
            >
              不会填
            </Button>
          )}
          <Button disabled={!text.trim() || pending} onClick={submit}>
            提交
          </Button>
        </div>
      )}

      {sourceBlock}
      {feedback}

      {result !== null && (
        <div className="flex justify-end">
          <Button onClick={onAdvance}>下一题</Button>
        </div>
      )}
    </div>
  );
}
