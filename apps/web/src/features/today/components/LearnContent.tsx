import type { TodayTaskView } from '@el/shared';
import { Volume2 } from 'lucide-react';
import { speak } from '../../../lib/tts';

/** 发音按钮：词/词块与例句共用（PRODUCT §12.1，优先 en-US voice） */
export function SpeakButton({ text, label }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label ?? `朗读 ${text}`}
      onClick={() => speak(text)}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted"
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
        <SpeakButton text={item.target} />
      </div>
      <p className="text-base text-foreground">{item.meaning}</p>
      {task.sourceExample && (
        <p className="flex items-start gap-1 text-sm text-muted-foreground">
          {task.sourceExample}
          <SpeakButton text={task.sourceExample} />
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
