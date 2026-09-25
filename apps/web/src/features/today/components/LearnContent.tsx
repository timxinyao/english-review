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
      <div className="flex items-center gap-2">
        <h2 className="text-2xl font-semibold text-foreground">{item.target}</h2>
        {/* Word 显示 IPA；Chunk 不显示（AGENTS §10） */}
        {item.type === 'word' && item.ipa && (
          <span className="text-sm text-muted-foreground">{item.ipa}</span>
        )}
        {/* 大号词的墨迹中心低于行框中心，图标下移 2px 做光学对齐 */}
        <SpeakButton text={item.target} className="translate-y-0.5" />
      </div>
      <p className="text-base text-foreground">{item.meaning}</p>
      {task.sourceExample && (
        <p className="flex items-start gap-1 text-sm text-muted-foreground">
          {task.sourceExample}
          {/* text-sm 行高 20px，按钮 32px：上移 6px 使图标中心对齐首行文字中心 */}
          <SpeakButton text={task.sourceExample} className="-mt-1.5" />
        </p>
      )}
      {supplementary.map((example) => (
        <p key={example} className="flex items-start gap-2 text-sm text-muted-foreground">
          <span className="mt-0.5 shrink-0 rounded border border-border px-1.5 py-0.5 text-xs">
            例句
          </span>
          {example}
        </p>
      ))}
    </div>
  );
}
