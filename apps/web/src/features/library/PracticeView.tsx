import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import type { PracticeAnswerRequest, PracticeAnswerResponse, PracticeQuestion } from '@el/shared';
import { ScrambleQuestionCard } from '../../components/scramble-question-card';
import { HighlightText } from '../../components/highlight-text';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import { speak } from '../../lib/tts';
import { ApiError } from '../../lib/api';
import { usePractice, usePracticeAnswer } from './api';

interface PracticeViewProps {
  itemId: string;
  onExit: () => void;
}

/** Recall 判语（与 Today RecallCard 三档一致：recalled=良好 / forgot=重来；
 *  basic_pass=assisted 仅历史/兼容）。easy→简单 无独立 result，按本次所按判语呈现 */
const RECALL_VERDICTS: Record<
  PracticeAnswerResponse['result'],
  { label: string; className: string }
> = {
  pass: { label: '良好', className: 'text-success' },
  basic_pass: { label: '提示后想起（基本通过）', className: 'text-warning' },
  fail: { label: '重来', className: 'text-destructive' },
};

interface RecallPracticeCardProps {
  question: Extract<PracticeQuestion, { qtype: 'recall' }>;
  result: PracticeAnswerResponse | null;
  pending: boolean;
  onSubmit: (body: PracticeAnswerRequest) => void;
  onAdvance: () => void;
}

/**
 * Recall 练习卡（V2 / Phase 9；PRODUCT §7.1 主动回忆优先）：
 * 与 Today 同款三档键（重来/良好/简单，2026-10-03），但释义只由作答响应揭示
 * （start 载荷不含 meaning，无「显示答案」前置、无 reveal 前泄漏）。
 * 非正式练习：不改正式进度，easy 与 recalled 响应同为 pass、仅判语不同。
 */
function RecallPracticeCard({
  question,
  result,
  pending,
  onSubmit,
  onAdvance,
}: RecallPracticeCardProps) {
  const [lastRecall, setLastRecall] = useState<PracticeAnswerRequest['recall'] | null>(null);
  const frozen = result !== null;
  const verdict = frozen
    ? lastRecall === 'easy'
      ? { label: '简单', className: 'text-success' }
      : RECALL_VERDICTS[result.result]
    : null;

  function submit(body: PracticeAnswerRequest) {
    if (body.recall) setLastRecall(body.recall);
    onSubmit(body);
  }

  const wordRow = (
    <div className="flex items-center gap-2">
      <h3 className="text-lg font-semibold text-foreground">{question.target}</h3>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground"
        aria-label="发音"
        onClick={() => void speak(question.target, { userGesture: true })}
      >
        <Volume2 className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      {wordRow}

      {question.context !== null && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">原句</span>
          <HighlightText text={question.context} target={question.target} />
        </p>
      )}

      {/* 冻结反馈：判语 + 释义揭示（reveal） */}
      {verdict && (
        <div className="space-y-2">
          <p className={cn('text-sm', verdict.className)}>{verdict.label}</p>
          <p className="text-base text-foreground">{result?.meaning}</p>
        </div>
      )}

      {!frozen && (
        <div className="space-y-2">
          {/* 与 Today 三档同款：重来(negative)/良好(primary)/简单(neutral) 等宽一排 */}
          <div className="flex gap-2">
            <Button
              variant="negative"
              className="flex-1"
              disabled={pending}
              onClick={() => submit({ recall: 'forgot' })}
            >
              重来
            </Button>
            <Button
              className="flex-1"
              disabled={pending}
              onClick={() => submit({ recall: 'recalled' })}
            >
              良好
            </Button>
            <Button
              variant="neutral"
              className="flex-1"
              disabled={pending}
              onClick={() => submit({ recall: 'easy' })}
            >
              简单
            </Button>
          </div>
        </div>
      )}

      {frozen && (
        <div className="flex justify-end">
          <Button onClick={onAdvance}>下一题</Button>
        </div>
      )}
    </div>
  );
}

/**
 * Library 单项“练一下”（V2 / Phase 9）：恰好 [recall] 或 [recall, production]，
 * 复用 Today 题型卡渲染；不改正式进度（静默，无额外文案），
 * 表达题优质句仍可入 Personal Example。
 */
export function PracticeView({ itemId, onExit }: PracticeViewProps) {
  const practice = usePractice(itemId);
  const answer = usePracticeAnswer(itemId);
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<PracticeAnswerResponse | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    practice.mutate();
    // 仅挂载时启动一次（ref 防 StrictMode 双调用；mutate 引用稳定）
  }, []);

  const questions = practice.data?.questions ?? [];
  const total = questions.length;
  const current: PracticeQuestion | undefined = questions[index];
  const finished = practice.isSuccess && !current;

  const advance = useCallback(() => {
    setResult(null);
    setIndex((i) => i + 1);
  }, []);

  function submit(body: PracticeAnswerRequest) {
    if (!current) return;
    answer.mutate({ questionId: current.questionId, body }, { onSuccess: setResult });
  }

  const productionError =
    answer.isError && !result ? (answer.error?.message ?? '批改失败，请重试。') : null;
  // 练一下无正式状态（超时无竞态概念）：错误码仅用于失败弹窗文案分支

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">练一下</h2>
        {/* 完成态只在完成卡片上保留一个“返回详情” */}
        {!finished && (
          <Button variant="ghost" size="sm" onClick={onExit}>
            返回详情
          </Button>
        )}
      </div>

      {practice.isError && (
        <div className="space-y-3 py-8 text-center">
          <p role="alert" className="text-sm text-destructive">
            生成练习失败：{practice.error?.message ?? '请重试。'}
          </p>
          <div className="flex justify-center gap-2">
            <Button variant="neutral" size="sm" onClick={() => practice.mutate()}>
              重试
            </Button>
          </div>
        </div>
      )}

      {practice.isPending && (
        <p className="py-16 text-center text-sm text-muted-foreground">正在生成练习…</p>
      )}

      {finished && (
        <div className="space-y-4 py-12 text-center">
          <p className="text-base font-medium text-foreground">练习完成</p>
          <Button variant="neutral" size="sm" onClick={onExit}>
            返回详情
          </Button>
        </div>
      )}

      {current && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {index + 1} / {total}
          </p>
          <article className="rounded-xl border border-border bg-card p-6">
            {current.qtype === 'recall' ? (
              <RecallPracticeCard
                question={current}
                result={result}
                pending={answer.isPending}
                onSubmit={submit}
                onAdvance={advance}
              />
            ) : 'kind' in current && current.kind === 'scramble' ? (
              <ScrambleQuestionCard
                question={current}
                result={result}
                pending={answer.isPending}
                error={productionError}
                onSubmitTokens={(selectedTokens) => submit({ selectedTokens })}
                onAdvance={advance}
              />
            ) : (
              <p className="text-sm text-destructive">表达题格式无效，请重新开始练习。</p>
            )}
          </article>
        </div>
      )}
    </section>
  );
}
