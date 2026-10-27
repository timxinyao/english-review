import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useStats } from './api';
import { HeatmapGrid } from './components/HeatmapGrid';

/** dl 行：label + 值（Quiet UI 行式排版，不堆卡片） */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border pb-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

export function StatsPage() {
  const { data, isLoading, isError } = useStats();

  if (isLoading) {
    return (
      <section className="space-y-2">
        <h1 className="hidden text-lg font-semibold md:block">Stats</h1>
        <p className="text-sm text-muted-foreground">加载中…</p>
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section className="space-y-2">
        <h1 className="hidden text-lg font-semibold md:block">Stats</h1>
        <p className="text-sm text-muted-foreground">读取失败，请刷新重试。</p>
      </section>
    );
  }

  const { totals } = data;
  const passRate =
    data.productionPassRate === null ? '暂无' : `${Math.round(data.productionPassRate * 100)}%`;
  const lowPass =
    data.productionPassRate !== null && data.productionPassRate < 0.4 && data.productionAttempts > 0;
  const earlyMastery = totals.mastered === 0 && totals.active > 0;

  return (
    <section className="space-y-8">
      <h1 className="hidden text-lg font-semibold md:block">Stats</h1>

      <dl className="space-y-3 text-sm">
        <Row label="总学习项">
          <span className="font-medium">{totals.items}</span>
          <span className="ml-2 text-xs text-muted-foreground">含已归档 {totals.archived} 项</span>
        </Row>
        <Row label="Word / Chunk">{`${totals.words} / ${totals.chunks}`}</Row>
        <Row label="学习中">{totals.active}</Row>
        <Row label="已掌握">{totals.mastered}</Row>
        <Row label="已暂停">{totals.paused}</Row>
        <Row label="已归档">{totals.archived}</Row>
        <Row label="New Queue 待学">{totals.newQueue}</Row>
        <Row label="最近 7 天正式任务">{data.last7DaysFormalTasks}</Row>
        <Row label="表达题通过率">
          {passRate}
          {data.productionPassRate !== null && (
            <span className="ml-2 text-xs text-muted-foreground">
              {data.productionPass} / {data.productionAttempts} 次作答
            </span>
          )}
        </Row>
        <Row label="最近 30 天新增">{data.last30DaysNewItems}</Row>
      </dl>

      {(earlyMastery || lowPass) && (
        <p className="text-sm text-muted-foreground">
          {lowPass
            ? '表达通过率还可以慢慢练。'
            : '掌握需要时间，先把今日到期清掉一小部分。'}{' '}
          <Link to="/today" className="text-accent hover:underline">
            去 Today
          </Link>
          {lowPass && (
            <>
              {' · '}
              <Link to="/library" className="text-accent hover:underline">
                在 Library 练一下
              </Link>
            </>
          )}
        </p>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">最近 12 个月</h2>
        <HeatmapGrid heatmap={data.heatmap} />
      </div>
    </section>
  );
}
