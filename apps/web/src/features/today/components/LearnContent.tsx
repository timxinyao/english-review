import { useCallback, useState, type ReactNode } from 'react';
import type { TodayTaskView } from '@el/shared';
import { Eye, Volume2 } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { speak, type TtsDebug } from '../../../lib/tts';

/**
 * 发音按钮：词/词块与例句共用（PRODUCT §12.1，优先 en-US voice）。
 * className 用于行内光学对齐：按钮 32px 高于小号文字行时按所在行的行高微调。
 */
export function SpeakButton({
  text,
  label,
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [debug, setDebug] = useState<TtsDebug | null>(null);

  const onSpeak = useCallback(() => {
    speak(text, (d) => setDebug(d.ok ? null : d)); // 仅出错时显示
  }, [text]);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label ?? `朗读 ${text}`}
        onClick={onSpeak}
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted',
          className,
        )}
      >
        <Volume2 className="h-4 w-4" aria-hidden />
      </button>
      {debug && (
        <span
          role="status"
          className={`absolute left-1/2 top-full z-30 mt-1 -translate-x-1/2 rounded-md px-2 py-1 text-xs whitespace-nowrap ${
            debug.ok ? 'bg-muted text-muted-foreground' : 'bg-destructive/10 text-destructive'
          }`}
        >
          {debug.message}
        </span>
      )}
    </span>
  );
}

/**
 * Learn 卡内容（两阶段，生成效应优先）：
 * 阶段 1：词 + 例句 + 发音，释义模糊——鼓励从上下文先猜
 * 阶段 2（点击后）：释义展开，题目才出现
 */
export function LearnContent({
  task,
  children,
}: {
  task: TodayTaskView;
  /** 题目内容（只在释义展开后渲染） */
  children?: ReactNode;
}) {
  const { item } = task;
  const supplementary = task.supplementaryExamples.slice(0, 1);
  const [revealed, setRevealed] = useState(false);

  return (
    <div>
      <div className="mb-6 space-y-3">
        {/* 词行：pr-12 给右上角浮动按钮让位 */}
        <div className="flex items-center gap-2 pr-12">
          <h2 className="text-2xl font-semibold text-foreground">{item.target}</h2>
          {item.type === 'word' && item.ipa && (
            <span className="text-sm text-muted-foreground">{item.ipa}</span>
          )}
          <SpeakButton text={item.target} className="translate-y-0.5" />
        </div>

        {/* 释义：文字始终占位（零布局抖动），未展开时覆盖模糊层 */}
        <div className="relative">
          <p className="select-none text-base text-foreground">{item.meaning}</p>
          {!revealed && (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="absolute inset-0 flex items-center gap-2 rounded-lg bg-card px-1 text-left"
              aria-label="点击显示释义"
            >
              <Eye className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="text-sm text-muted-foreground">点击显示释义</span>
            </button>
          )}
        </div>

        {/* 例句分区 */}
        {task.sourceExample && (
          <div className="border-l-2 border-border pl-3">
            <p className="mb-0.5 text-xs text-muted-foreground">原句</p>
            <div className="flex items-start gap-1">
              <p className="text-base leading-relaxed text-foreground">{task.sourceExample}</p>
              <SpeakButton text={task.sourceExample} className="-mt-1" />
            </div>
          </div>
        )}
        {supplementary.map((example) => (
          <div key={example} className="border-l-2 border-accent/30 pl-3">
            <p className="mb-0.5 text-xs text-muted-foreground">补充例句</p>
            <p className="text-base leading-relaxed text-foreground">{example}</p>
          </div>
        ))}
      </div>

      {/* 题目始终渲染；释义模糊只影响释义本身 */}
      {children}
    </div>
  );
}
