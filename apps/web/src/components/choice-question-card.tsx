import { useMemo, useState } from 'react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { HighlightText } from './highlight-text';
import { shuffled } from '../lib/questions';
import type { QuestionAnswerResult } from './question-answer';

export interface ChoiceQuestionData {
  questionId: string;
  context: string | null;
  question: string;
  options: readonly { id: string; text: string }[];
}

interface ChoiceQuestionCardProps {
  question: ChoiceQuestionData;
  /** 学习项目标词，用于上下文高亮（可选：PracticeView 无此上下文时省略） */
  target?: string;
  /** 冻结的作答结果（null = 尚未作答） */
  result: QuestionAnswerResult | null;
  pending: boolean;
  /** 提交选项（viewedSource 由本组件跟踪：答前点过“查看原句”则为 true） */
  onSubmitOption: (optionId: string, meta: { viewedSource: boolean }) => void;
  onAdvance: () => void;
  /** 提供时展示“查看原句”，答错自动揭示（Today 传 source example；练习不传） */
  sourceExample?: string | null;
  /** 提供时展示“太简单了”反馈（Today 专用；「其实是蒙的」已按 §7.6 移除） */
  onFeedback?: (kind: 'too_easy') => void;
  /** 主动不会（Today 专用，§7.6）：缺省=练一下布局，不出该入口 */
  onGiveUp?: () => void;
  /** Today 沉浸式布局：题干/反馈滚动 + 选项停靠底部 dock（缺省=练一下原版式） */
  variant?: 'today';
  /** 冻结判语交由外部（Recall 反馈）呈现时隐藏（Today 专用） */
  hideVerdict?: boolean;
}

/** 选择题渲染与作答交互（PRODUCT §7.1/§7.6）；Today 与 Library 练一下共用 */
export function ChoiceQuestionCard({
  question,
  target,
  result,
  pending,
  onSubmitOption,
  onAdvance,
  sourceExample = null,
  onFeedback,
  onGiveUp,
  variant,
  hideVerdict,
}: ChoiceQuestionCardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewedSource, setViewedSource] = useState(false);

  // 前端 shuffle：同一 questionId 顺序稳定（useMemo 缓存），提交的仍是原 option id
  const options = useMemo(
    () => shuffled(question.options, question.questionId),
    [question.options, question.questionId],
  );

  const phase = result ? (result.correct ? 'correct' : 'wrong') : 'answering';
  const gaveUp = result?.gaveUp === true;
  const canRevealSource = sourceExample !== null;
  const showSource = canRevealSource && (viewedSource || phase === 'wrong');
  const correctText = question.options.find((o) => o.id === result?.correctOptionId)?.text;
  // 勾选标记优先取服务端回传（回看/回放重挂载后仍成立）；答前选择由本地状态兜底（练一下）
  const chosenId = result?.selectedOptionId ?? selectedId;

  function submit(optionId: string) {
    setSelectedId(optionId);
    onSubmitOption(optionId, { viewedSource });
  }

  const body = (
    <>
      {question.context && (
        <p className="text-sm italic text-muted-foreground">
          <HighlightText text={question.context} target={target ?? ''} />
        </p>
      )}
      <p className="text-base text-foreground">{question.question}</p>

      {showSource && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">原句</span>
          {sourceExample}
        </p>
      )}

      {phase !== 'answering' && !hideVerdict && (
        <p className={cn('text-sm', gaveUp || phase === 'wrong' ? 'text-destructive' : 'text-success')}>
          {gaveUp ? '主动不会' : phase === 'correct' ? '回答正确' : '回答错误'}
        </p>
      )}
      {/* 纠错：正确答案文字 + 理由（答对时勾选标记已足够，不重复文字行） */}
      {phase !== 'answering' && phase === 'wrong' && result?.correctOptionId && (
        <p className="text-sm">
          <span className="text-muted-foreground">正确答案：</span>
          <span className="text-success">{correctText}</span>
        </p>
      )}
      {phase === 'wrong' && result?.explanation && (
        <p className="text-sm text-muted-foreground">{result.explanation}</p>
      )}
      {phase === 'correct' && onFeedback && (
        <div>
          <button
            type="button"
            className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted"
            onClick={() => onFeedback('too_easy')}
          >
            太简单了
          </button>
        </div>
      )}
    </>
  );

  const optionGroup = (
    <div role="group" aria-label="选项" className={cn('space-y-2', variant === 'today' && 'max-h-[40vh] overflow-y-auto')}>
      {options.map((option) => {
        const isChosen = chosenId === option.id;
        const isCorrect = result?.correct ? isChosen : result?.correctOptionId === option.id;
        return (
          <Button
            key={option.id}
            variant="outline"
            aria-pressed={isChosen}
            disabled={pending || phase !== 'answering'}
            className={cn(
              'w-full justify-start text-left',
              // 仅在真实选错时标记错误选项；主动不会未作答，不虚构标记（§7.6）
              isChosen && phase === 'wrong' && !gaveUp && 'border-destructive text-destructive',
              isCorrect && 'border-success text-success',
            )}
            onClick={() => submit(option.id)}
          >
            {option.text}
          </Button>
        );
      })}
    </div>
  );

  if (variant === 'today') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto" data-slot="body">
          {body}
        </div>
        <div className="mt-3 shrink-0 space-y-2 border-t border-border pt-3" data-slot="dock">
          {optionGroup}
          {phase === 'answering' && (
            <div className="flex items-center justify-between gap-2">
              {canRevealSource && !viewedSource ? (
                <Button variant="ghost" size="sm" onClick={() => setViewedSource(true)}>
                  查看原句
                </Button>
              ) : (
                <span />
              )}
              {onGiveUp && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={pending}
                  onClick={onGiveUp}
                >
                  不会
                </Button>
              )}
            </div>
          )}
          {phase !== 'answering' && (
            <div className="flex justify-end">
              <Button onClick={onAdvance}>下一题</Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {body}

      {optionGroup}

      {phase === 'answering' && canRevealSource && !viewedSource && (
        <Button variant="ghost" size="sm" onClick={() => setViewedSource(true)}>
          查看原句
        </Button>
      )}
      {phase === 'answering' && onGiveUp && (
        <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={pending} onClick={onGiveUp}>
          不会
        </Button>
      )}

      {phase !== 'answering' && (
        <div className="flex items-center justify-between gap-2">
          <span />
          <Button onClick={onAdvance}>下一题</Button>
        </div>
      )}
    </div>
  );
}
