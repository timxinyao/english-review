import type { TodayIdleResponse } from '@el/shared';
import { Button } from '../../../components/ui/button';
import { useStartSession } from '../api';
import { StartSessionDialog } from './StartSessionDialog';

export const RECENTLY_LEARNED_MAX = 5;

/** idle 态：一页一个主动作——开始今日复习（PRODUCT §5.1） */
export function IdleToday({ data }: { data: TodayIdleResponse }) {
  const start = useStartSession();

  return (
    <div className="space-y-8">
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          词汇总数 {data.totalItems} · 待学 {data.newQueueCount} · 今日到期 {data.dueItems} 项 ·
          可新学 {data.newTodayAvailable}
        </p>
        <Button
          size="lg"
          className="mt-5"
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          {start.isPending ? '正在开始…' : '开始今日复习'}
        </Button>
      </div>

      {/* 条件挂载（非常驻 return null）：计时起点 useState 初值取挂载时刻才不失真 */}
      {(start.isPending || start.isError) && (
        <StartSessionDialog
          pending={start.isPending}
          errorMessage={
            start.isError ? ((start.error as Error | undefined)?.message ?? '请稍候重试') : null
          }
          onRetry={() => start.mutate()}
          onDismiss={() => start.reset()}
        />
      )}

      {data.recentlyLearned.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground">
            Recently learned
          </p>
          <ul className="border-t border-border">
            {data.recentlyLearned.slice(0, RECENTLY_LEARNED_MAX).map((item) => (
              <li key={item.id} className="border-b border-border py-2.5 text-sm text-foreground">
                {item.target}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
