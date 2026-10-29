import type { TodayIdleResponse } from '@el/shared';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { buttonVariants } from '../../../components/ui/button';
import { Button } from '../../../components/ui/button';
import { useStartSession } from '../api';
import { StartSessionDialog } from './StartSessionDialog';

export const RECENTLY_LEARNED_MAX = 5;

/** idle 态：一页一个主动作——开始今日复习（PRODUCT §5.1）；
 *  今日计划/积压用 API 真实数字拆分展示（plannedReviews/backlogLeft，2026-10-27），不假造 */
export function IdleToday({ data }: { data: TodayIdleResponse }) {
  const start = useStartSession();
  const reviews = data.plannedReviews;
  const newToday = data.newTodayAvailable;
  const plannedTotal = reviews + newToday;

  return (
    <div className="mx-auto max-w-xl space-y-8 pb-28 pt-5 md:pt-10">
      <div className="space-y-4 text-center">
        <h1 className="text-[28px] text-balance font-semibold tracking-tight leading-tight md:text-4xl">
          每天一点，慢慢记住。
        </h1>
        {plannedTotal > 0 ? (
          <p className="text-sm text-foreground">
            {reviews > 0 && newToday > 0
              ? `今日计划 ${plannedTotal} 题（复习 ${reviews} · 新学 ${newToday}）`
              : reviews > 0
                ? `今日计划 ${reviews} 题复习`
                : `今日学 ${newToday} 个新词`}
          </p>
        ) : (
          <p className="text-sm text-foreground">今天没有到期的复习</p>
        )}
        {data.backlogLeft > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            积压还剩 {data.backlogLeft} 题，之后每天自动安排
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          词库 {data.totalItems} · 待学 {data.newQueueCount}
        </p>
        {plannedTotal > 0 ? (
          <Button
            size="lg"
            className="mt-5 w-full h-14"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {start.isPending ? '正在开始…' : '开始今日复习'}
            <ArrowRight className="h-5 w-5" aria-hidden />
          </Button>
        ) : (
          <Link to="/library" className={buttonVariants({ size: 'lg', className: 'mt-5 w-full' })}>
            看看词库
          </Link>
        )}
        <p className="mt-3 text-xs text-muted-foreground">做一点也行，不必一次清完</p>
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
        <div className="space-y-3">
          <p className="text-base font-semibold text-foreground">最近学过</p>
          <ul className="overflow-hidden rounded-xl bg-card divide-y divide-border">
            {data.recentlyLearned.slice(0, RECENTLY_LEARNED_MAX).map((item) => (
              <li key={item.id}>
                <Link
                  to={`/library/${item.id}`}
                  className="flex min-h-20 items-center justify-between gap-3 px-5 py-4 hover:bg-muted focus-visible:outline-offset-[-3px]"
                >
                  <div className="min-w-0">
                    <p className="text-2xl font-literary text-foreground break-words">
                      {item.target}
                    </p>
                    {item.meaning.trim() && (
                      <p className="mt-0.5 text-[13px] text-muted-foreground">{item.meaning}</p>
                    )}
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
