import { useCallback, useEffect, useRef, useState } from 'react';
import type { PracticeAnswerRequest, PracticeAnswerResponse, PracticeQuestion } from '@el/shared';
import { ChoiceQuestionCard } from '../../components/choice-question-card';
import { ClozeQuestionCard } from '../../components/cloze-question-card';
import { ProductionQuestionCard } from '../../components/production-question-card';
import { Button } from '../../components/ui/button';
import { CORRECT_AUTO_ADVANCE_MS } from '../../lib/questions';
import { usePractice, usePracticeAnswer } from './api';

interface PracticeViewProps {
  itemId: string;
  onExit: () => void;
}

/**
 * Library 单项“练一下”（PRODUCT §4.4）：临时 3 题、复用 Today 题型卡渲染；
 * 不改正式进度（静默，无额外文案），表达题优质句仍可入 Personal Example。
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

  // 选择题答对：约 2 秒自动下一题/点击任意处继续（与 Today 一致）；填空/表达手动
  useEffect(() => {
    if (!result?.correct || current?.qtype !== 'choice') return;
    const timer = setTimeout(advance, CORRECT_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [result, current, advance]);

  function submit(body: PracticeAnswerRequest) {
    if (!current) return;
    answer.mutate({ questionId: current.questionId, body }, { onSuccess: setResult });
  }

  const productionError =
    answer.isError && !result ? (answer.error?.message ?? '批改失败，请重试。') : null;

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
            <Button variant="outline" size="sm" onClick={() => practice.mutate()}>
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
          <Button variant="outline" size="sm" onClick={onExit}>
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
            {current.qtype === 'choice' ? (
              <ChoiceQuestionCard
                question={current}
                result={result}
                pending={answer.isPending}
                onSubmitOption={(optionId) => submit({ selectedOptionId: optionId })}
                onAdvance={advance}
              />
            ) : current.qtype === 'cloze' ? (
              <ClozeQuestionCard
                question={current}
                result={result}
                pending={answer.isPending}
                onSubmitText={(text) => submit({ answerText: text })}
                onAdvance={advance}
              />
            ) : (
              <ProductionQuestionCard
                question={current}
                result={result}
                pending={answer.isPending}
                error={productionError}
                onSubmitText={(text) => submit({ answerText: text })}
                onAdvance={advance}
              />
            )}
          </article>
        </div>
      )}
    </section>
  );
}
