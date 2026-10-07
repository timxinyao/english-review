import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AutoGrowTextarea, Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { CorrectionDiff } from './correction-diff';
import { HighlightText } from './highlight-text';
import { PRODUCTION_VERDICTS, type QuestionAnswerResult } from './question-answer';
import { positionTodayDockAfterClick, rememberTodayInputTouch } from '../lib/keyboard-inset';
import { playGradingCue } from '../lib/sound';

export interface ProductionQuestionData {
  questionId: string;
  zhPrompt: string;
  mustUse: string;
}

/**
 * 批改等待预算（秒）：与服务端 checkProduction totalBudgetMs=120s 对齐
 * （apps/api taskConfig——批改失败正常路径在 120s 落地；前端 150s 中止是冻结兜底，不作展示锚点）。
 */
const GRADING_BUDGET_SECONDS = 120;

/** 批改用时展示：<10s 保留一位小数（区分快慢），≥10s 取整 */
function formatGradingDuration(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

interface ProductionQuestionCardProps {
  question: ProductionQuestionData;
  result: QuestionAnswerResult | null;
  pending: boolean;
  /** 批改失败的可读信息（如 AI_PROVIDER_ERROR）；输入保留由组件自身状态保证 */
  error: string | null;
  /** error 的结构化错误码（如 REQUEST_TIMEOUT，lib/api ApiError.code）：决定失败弹窗文案分支 */
  errorCode?: string | null;
  onSubmitText: (text: string) => void;
  /** 批改中取消（2026-10-05）：掐断请求（服务端未落库则作答作废）并回到可编辑态 */
  onCancelGrading?: () => void;
  /** 主动不会（Today 专用，§7.6）：缺省=练一下布局，不出该入口 */
  onGiveUp?: () => void;
  onAdvance: () => void;
  /** Today 沉浸式布局：提示/反馈滚动 + 输入/按钮停靠底部 dock（§5.1 键盘弹出仍可达） */
  variant?: 'today';
}

/** 表达题：受控中文提示 + 批改结果（PRODUCT §7.3/§7.4/§7.6）；Today 与练一下共用。
 *  主动不会（gaveUp）揭示参考句/用法说明且无批改，不渲染最小纠错 diff。
 *  批改中（pending）：提交按钮原地替换为「取消」+ 按钮上方 2px 动态进度线 +
 *  正计时「正在批改 已流逝/120」（≥30s 转 accent 提示进入长尾区）；
 *  取消后输入保留、按钮恢复「提交」可改写重交；结果卡头部右侧显示本轮批改用时。
 *  批改失败（2026-10-05）：弹「批改未完成」对话框（返回修改/重试原句直接重交），
 *  同一错误只弹一次（新一轮提交后失败会再弹），卡上红字保留可见原因。 */
export function ProductionQuestionCard({
  question,
  result,
  pending,
  error,
  errorCode,
  onSubmitText,
  onCancelGrading,
  onGiveUp,
  onAdvance,
  variant,
}: ProductionQuestionCardProps) {
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  // 批改正计时（2026-10-06）：pending 期间显示 已流逝/预算（120s）；结束时记录本轮批改用时，
  // 仅在结果卡展示（取消/失败无结果不显示；新一轮提交清零重来）。
  const pendingSinceRef = useRef<number | null>(null);
  const prevPendingRef = useRef(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [gradingDurationMs, setGradingDurationMs] = useState<number | null>(null);
  useEffect(() => {
    if (pending && !prevPendingRef.current) {
      pendingSinceRef.current = Date.now();
      setGradingDurationMs(null);
      setElapsedSeconds(0);
    } else if (!pending && prevPendingRef.current) {
      const started = pendingSinceRef.current;
      pendingSinceRef.current = null;
      setElapsedSeconds(0);
      if (started !== null) setGradingDurationMs(Date.now() - started);
    }
    prevPendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => {
      if (pendingSinceRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - pendingSinceRef.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [pending]);

  // 失败弹窗快照（非 null 即弹窗打开）：armed 标记保证同一错误只弹一次，
  // 新一轮提交（pending=true）重新武装——重试/改写后再失败会再弹。
  const [failed, setFailed] = useState<{ message: string; timeout: boolean } | null>(null);
  const failureArmedRef = useRef(true);
  useEffect(() => {
    if (pending) {
      failureArmedRef.current = true;
      return;
    }
    if (!failureArmedRef.current || result || !error) return;
    failureArmedRef.current = false;
    setFailed({ message: error, timeout: errorCode === 'REQUEST_TIMEOUT' });
  }, [error, errorCode, pending, result]);

  // 前台批改提示音（PRODUCT §5.1）：结果到达（主动不会无批改不响）/ 批改失败各一响；
  // 取消（abort）不产生 error/result 变化，天然静音。StrictMode 双执行由 sound 内部 200ms 防抖兜底。
  useEffect(() => {
    if (result) {
      if (!result.gaveUp) playGradingCue(result.result === 'fail' ? 'fail' : 'done');
    } else if (error) {
      playGradingCue('fail');
    }
  }, [result, error]);

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

  const target = (
    <p className="production-target shrink-0 text-sm text-muted-foreground">
      必须使用：
      <span className="font-literary text-2xl text-accent">{question.mustUse}</span>
      {/* 键盘不收起（2026-10-07 真机复测）：iOS tap-focus 启发式会把焦点抢给可聚焦元素，
          pointerdown preventDefault 拦不住 WebKit 触摸阶段的焦点转移——改用不可聚焦 span
          （tabIndex=-1，iOS 不向不可聚焦元素移焦点 → 输入框保持焦点、键盘原位）；
          Enter/Space 激活保留无障碍语义；样式参考词典 App：[复制] 跟在词后 */}
      <span
        role="button"
        tabIndex={-1}
        aria-label="复制目标词"
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={copyTarget}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            copyTarget();
          }
        }}
        className="-my-0.5 ml-1.5 cursor-pointer select-none rounded-sm text-xs font-medium text-accent transition-opacity active:opacity-60"
      >
        [复制]
      </span>
    </p>
  );

  // 复制成功 Toast：底部深色半透明圆角条（portal 出卡片滚动容器外），1.5s 随 copied 状态消失
  const copiedToast =
    copied &&
    createPortal(
      <div
        role="status"
        data-copy-toast
        className="pointer-events-none fixed inset-x-0 bottom-24 z-overlay flex justify-center px-4"
      >
        <span className="rounded-full bg-foreground/75 px-4 py-2 text-sm text-background shadow-lg">
          内容已经复制到剪贴板
        </span>
      </div>,
      document.body,
    );

  const prompt = (
    <div className="space-y-4 break-words pr-8">
      <p className="text-xs text-muted-foreground">用英语表达</p>
      <p className="text-xl leading-relaxed text-foreground">{question.zhPrompt}</p>
      {target}
    </div>
  );

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    onSubmitText(trimmed);
  }

  /** 弹窗 [返回修改]（默认）：关弹窗回可编辑态——error 仍置位，卡上红字保留可见原因 */
  function dismissFailure() {
    setFailed(null);
  }

  /** 弹窗 [重试]：原句直接重交（组件内 text state 保留，无需用户重新输入） */
  function retryFromFailure() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setFailed(null);
    onSubmitText(trimmed);
  }

  // 失败弹窗（与撤销/坏题确认层同款 portal 对话框）：遮罩点击等同「返回修改」
  const failureDialog =
    failed !== null &&
    createPortal(
      <div
        role="dialog"
        aria-label="批改未完成"
        aria-modal="true"
        className="fixed inset-0 z-overlay flex items-center justify-center bg-foreground/20 p-4"
        onClick={dismissFailure}
      >
        <div
          className="w-full max-w-[340px] space-y-3 rounded-xl border border-border bg-card p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-sm font-medium text-foreground">批改未完成</p>
          <p className="text-sm text-foreground">
            {failed.timeout
              ? '网络或服务超时，本次作答未计入成绩，可重试。'
              : `${failed.message} 本次作答未计入，可重试。`}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" autoFocus onClick={dismissFailure}>
              返回修改
            </Button>
            <Button size="sm" disabled={!text.trim()} onClick={retryFromFailure}>
              重试
            </Button>
          </div>
        </div>
      </div>,
      document.body,
    );

  // 批改中状态（quiet）：2px 动态进度线 + 「正在批改…」文案（不与 spinner 堆叠）
  const gradingBar = pending && (
    <div
      aria-hidden
      data-grading-progress={''}
      className="h-0.5 w-full animate-pulse rounded-full bg-gradient-to-r from-transparent via-accent to-transparent"
    />
  );
  const gradingLabel = (
    <span
      data-grading-label
      className={cn(
        'text-xs tabular-nums',
        elapsedSeconds >= 30 ? 'text-accent' : 'text-muted-foreground',
      )}
    >
      正在批改 {elapsedSeconds}/{GRADING_BUDGET_SECONDS}
    </span>
  );

  const errorBlock = error && !result && (
    <p role="alert" className="text-sm text-destructive">
      批改失败：{error}
    </p>
  );

  const feedback = result && (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <p
          className={cn(
            'text-sm font-medium',
            result.gaveUp ? 'text-destructive' : PRODUCTION_VERDICTS[result.result].className,
          )}
        >
          {result.gaveUp ? '主动不会' : PRODUCTION_VERDICTS[result.result].label}
        </p>
        {!result.gaveUp && gradingDurationMs !== null && (
          <span data-grading-duration className="text-xs tabular-nums text-muted-foreground">
            批改用时 {formatGradingDuration(gradingDurationMs)}
          </span>
        )}
      </div>
      {result.gaveUp ? (
        <>
          {result.referenceAnswer && (
            <p className="study-example">
              <span className="mb-1 block text-xs text-muted-foreground">参考句</span>
              <HighlightText text={result.referenceAnswer} target={question.mustUse} />
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
              betterVersionKind={result.correction.betterVersionKind}
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
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-production-input={!result ? '' : undefined}
      >
        {failureDialog}
        {copiedToast}
        {!result ? (
          <div className="production-context min-h-0 flex-1 break-words pr-8" data-slot="body">
            <p className="production-label text-xs text-muted-foreground">用英语表达</p>
            <div className="production-prompt-scroll min-h-0 overflow-y-auto">
              <p className="production-prompt-text text-xl leading-relaxed text-foreground">
                {question.zhPrompt}
              </p>
              {errorBlock}
            </div>
            {target}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-1" data-slot="body">
            {prompt}
            {feedback}
          </div>
        )}
        {!result ? (
          <div className="study-dock space-y-3" data-slot="dock">
            <AutoGrowTextarea
              aria-label="表达答案"
              lang="en"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="resize-none"
              placeholder="Write your sentence in English…"
              value={text}
              disabled={pending}
              onPointerDown={rememberTodayInputTouch}
              onClick={positionTodayDockAfterClick}
              onChange={(e) => setText(e.target.value)}
            />
            {gradingBar}
            <div className="flex items-center justify-between gap-2">
              {pending ? (
                gradingLabel
              ) : onGiveUp ? (
                <Button variant="ghost" size="sm" onClick={onGiveUp}>
                  不会表达
                </Button>
              ) : (
                <span />
              )}
              {pending ? (
                <Button variant="negative" onClick={() => onCancelGrading?.()}>
                  取消
                </Button>
              ) : (
                <Button disabled={!text.trim()} onClick={submit}>
                  {error ? '重试' : '提交'}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="study-dock flex justify-end" data-slot="dock">
            <Button onClick={onAdvance}>下一题</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {failureDialog}
      {copiedToast}
      {prompt}

      {!result && (
        <div className="space-y-2">
          <Textarea
            aria-label="表达答案"
            lang="en"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            rows={5}
            className="resize-none"
            placeholder="Write your sentence in English…"
            value={text}
            disabled={pending}
            onChange={(e) => setText(e.target.value)}
          />
          {errorBlock}
          {onGiveUp && (
            <Button variant="ghost" size="sm" disabled={pending} onClick={onGiveUp}>
              不会表达
            </Button>
          )}
          {gradingBar}
          <div className="flex items-center justify-end gap-2">
            {pending && gradingLabel}
            {pending ? (
              <Button variant="negative" onClick={() => onCancelGrading?.()}>
                取消
              </Button>
            ) : (
              <Button disabled={!text.trim()} onClick={submit}>
                {error ? '重试' : '提交'}
              </Button>
            )}
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
