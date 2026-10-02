import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { CorrectionDiff } from './correction-diff';
import { PRODUCTION_VERDICTS, type QuestionAnswerResult } from './question-answer';
import { positionTodayDockAfterClick, rememberTodayInputTouch } from '../lib/keyboard-inset';

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
  /** 主动不会（Today 专用，§7.6）：缺省=练一下布局，不出该入口 */
  onGiveUp?: () => void;
  onAdvance: () => void;
  /** Today 沉浸式布局：提示/反馈滚动 + 输入/按钮停靠底部 dock（§5.1 键盘弹出仍可达） */
  variant?: 'today';
}

const textareaClass =
  'flex w-full rounded-lg border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

/** 表达题：受控中文提示 + 批改结果（PRODUCT §7.3/§7.4/§7.6）；Today 与练一下共用。
 *  主动不会（gaveUp）揭示参考句/用法说明且无批改，不渲染最小纠错 diff。 */
export function ProductionQuestionCard({
  question,
  result,
  pending,
  error,
  onSubmitText,
  onGiveUp,
  onAdvance,
  variant,
}: ProductionQuestionCardProps) {
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  async function copyTarget() {
    try {
      await navigator.clipboard.writeText(question.mustUse);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板被拒（非用户手势等）：静默保持原样，不打断作答
    }
  }

  const prompt = (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">用英语表达</p>
      <p className="text-lg leading-relaxed text-foreground">{question.zhPrompt}</p>
      <p className="text-sm text-muted-foreground">
        必须使用：
        <span className="font-medium text-accent">{question.mustUse}</span>
        <button
          type="button"
          aria-label={copied ? '已复制' : '复制目标词'}
          onClick={copyTarget}
          className="-my-1 ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </p>
    </div>
  );

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    onSubmitText(trimmed);
  }

  const errorBlock = error && !result && (
    <p role="alert" className="text-sm text-destructive">
      批改失败：{error}
    </p>
  );

  const feedback = result && (
    <div className="space-y-3">
      <p
        className={cn(
          'text-sm font-medium',
          result.gaveUp ? 'text-destructive' : PRODUCTION_VERDICTS[result.result].className,
        )}
      >
        {result.gaveUp ? '主动不会' : PRODUCTION_VERDICTS[result.result].label}
      </p>
      {result.gaveUp ? (
        <>
          {result.referenceAnswer && (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
              <span className="mr-1 text-xs text-muted-foreground">参考句</span>
              {result.referenceAnswer}
            </p>
          )}
          {result.answerNote && (
            <p className="text-sm">
              <span className="text-muted-foreground">用法：</span>
              {result.answerNote}
            </p>
          )}
          {result.explanation && (
            <p className="text-sm text-muted-foreground">{result.explanation}</p>
          )}
        </>
      ) : (
        <>
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
        </>
      )}
    </div>
  );

  if (variant === 'today') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto" data-slot="body">
          {prompt}
          {errorBlock}
          {feedback}
        </div>
        {!result ? (
          <div className="mt-3 shrink-0 space-y-2 border-t border-border pt-3" data-slot="dock">
            <textarea
              aria-label="表达答案"
              rows={3}
              className={textareaClass}
              placeholder="Write your sentence in English…"
              value={text}
              disabled={pending}
              onPointerDown={rememberTodayInputTouch}
              onClick={positionTodayDockAfterClick}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex items-center justify-between gap-2">
              {onGiveUp ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={pending}
                  onClick={onGiveUp}
                >
                  不会表达
                </Button>
              ) : (
                <span />
              )}
              <Button disabled={!text.trim() || pending} onClick={submit}>
                {pending ? '批改中…' : error ? '重试' : '提交'}
              </Button>
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
      {prompt}

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
          {errorBlock}
          {onGiveUp && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={pending}
              onClick={onGiveUp}
            >
              不会表达
            </Button>
          )}
          <div className="flex justify-end">
            <Button disabled={!text.trim() || pending} onClick={submit}>
              {pending ? '批改中…' : error ? '重试' : '提交'}
            </Button>
          </div>
        </div>
      )}

      {feedback}

      {result && (
        <div className="flex justify-end">
          <Button onClick={onAdvance}>下一题</Button>
        </div>
      )}
    </div>
  );
}
