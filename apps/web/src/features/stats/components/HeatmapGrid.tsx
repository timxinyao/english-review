import { useMemo } from 'react';
import type { HeatmapCell } from '@el/shared';
import { buildHeatmapLayout, heatmapCellClass, heatmapCellTitle } from '../heatmap';

/** 图例四档色阶样例（少 → 多） */
const LEGEND_COUNTS = [0, 5, 15, 25];

function MonthLabels({ labels }: { labels: (string | null)[] }) {
  return (
    <div className="flex gap-0.5" aria-hidden>
      {labels.map((label, i) => (
        <div key={i} className="w-2.5 shrink-0">
          {label && (
            <span className="whitespace-nowrap text-xs text-muted-foreground">{label}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function HeatmapGrid({ heatmap }: { heatmap: HeatmapCell[] }) {
  const { weeks, monthLabels } = useMemo(() => buildHeatmapLayout(heatmap), [heatmap]);
  const allZero = heatmap.length > 0 && heatmap.every((c) => c.count === 0);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <div className="min-w-max space-y-1">
          <MonthLabels labels={monthLabels} />
          <div className="flex gap-0.5">
            {weeks.map((week, col) => (
              <div key={col} className="flex flex-col gap-0.5">
                {week.map((cell, row) =>
                  cell ? (
                    <div
                      key={cell.date}
                      title={heatmapCellTitle(cell)}
                      className={`h-2.5 w-2.5 rounded-sm ${heatmapCellClass(cell.count)}`}
                    />
                  ) : (
                    <div key={`empty-${row}`} className="h-2.5 w-2.5" />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>少</span>
        {LEGEND_COUNTS.map((count) => (
          <span key={count} className={`h-2.5 w-2.5 rounded-sm ${heatmapCellClass(count)}`} />
        ))}
        <span>多</span>
      </div>
      {allZero && (
        <p className="text-xs text-muted-foreground">
          最近一年还没有正式复习记录；完成 Today 任务后，这里会逐渐点亮。
        </p>
      )}
    </div>
  );
}
