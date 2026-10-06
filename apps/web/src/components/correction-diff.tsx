import type { CorrectionSegment } from '@el/shared';

/**
 * 表达题批改 diff（PRODUCT §7.4/§12.2）：
 * same 正文色、delete 红色删除线、insert 绿色；
 * betterVersion 默认展开（2026-10-03：更自然的说法直接可见），为 null 不渲染。
 */
interface CorrectionDiffProps {
  segments: readonly CorrectionSegment[];
  /** 有修改时展示一行干净的纠正句（通过/全 same 时不重复展示） */
  correctedSentence?: string;
  betterVersion: string | null;
  /** null/缺省用于兼容旧记录，沿用“更自然的说法”展示语义。 */
  betterVersionKind?: 'polish' | 'rewrite' | null;
}

const SEGMENT_CLASSES: Record<CorrectionSegment['type'], string> = {
  same: 'text-foreground',
  delete: 'text-diff-delete line-through',
  insert: 'text-diff-insert',
};

export function CorrectionDiff({
  segments,
  correctedSentence,
  betterVersion,
  betterVersionKind,
}: CorrectionDiffProps) {
  const hasChanges = segments.some((seg) => seg.type !== 'same');

  return (
    <div className="space-y-2">
      <p className="text-base leading-relaxed" aria-label="批改对照">
        {segments.map((seg, i) => (
          <span key={i} className={SEGMENT_CLASSES[seg.type]}>
            {seg.text}
          </span>
        ))}
      </p>
      {hasChanges && correctedSentence && (
        <p className="text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">纠正后</span>
          {correctedSentence}
        </p>
      )}
      {betterVersion && (
        <details className="text-sm" open>
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">
            {betterVersionKind === 'rewrite' ? '参考表达' : '更自然的说法'}
          </summary>
          <p className="mt-1 text-foreground">{betterVersion}</p>
        </details>
      )}
    </div>
  );
}
