import type { TodayTaskView } from '@el/shared';
import { Volume2 } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { speak } from '../../../lib/tts';

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
  return (
    <button
      type="button"
      aria-label={label ?? `朗读 ${text}`}
      onClick={() => speak(text)}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted',
        className,
      )}
    >
      <Volume2 className="h-4 w-4" aria-hidden />
    </button>
  );
}

/** Learn 卡内容：target（word 附 IPA）+ 发音 + meaning + 原句 + 最多 1 条补充例句 */
export function LearnContent({ task }: { task: TodayTaskView }) {
  const { item } = task;
  const supplementary = task.supplementaryExamples.slice(0, 1);

  return (
    <div className="mb-6 space-y-3">
      {/* 词行：pr-12 给右上角浮动按钮让位 */}
      <div className="flex items-center gap-2 pr-12">
        <h2 className="text-2xl font-semibold text-foreground">{item.target}</h2>
        {item.type === 'word' && item.ipa && (
          <span className="text-sm text-muted-foreground">{item.ipa}</span>
        )}
        <SpeakButton text={item.target} className="translate-y-0.5" />
      </div>
      <p className="text-base text-foreground">{item.meaning}</p>

      {/* 例句分区：左侧竖线 + 标签区分原句/补充 */}
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
  );
}
