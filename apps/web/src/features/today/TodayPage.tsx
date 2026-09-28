import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useTodayStatus } from './api';
import { ActiveSession, type FrozenAnswer } from './components/ActiveSession';
import { CompletedToday } from './components/CompletedToday';
import { IdleToday } from './components/IdleToday';

/**
 * Today：产品核心页，按 GET /api/today 三态渲染（idle / active / completed）。
 * 作答反馈冻结在页面级：最后一题答完即使状态已翻转为 completed，
 * 仍先展示该题反馈，advance 后才进入完成摘要。
 */
export function TodayPage() {
  const { data, isLoading, isError, isFetching, refetch } = useTodayStatus();
  const [frozen, setFrozen] = useState<FrozenAnswer | null>(null);
  const advance = useCallback(() => setFrozen(null), []);

  // Recall 评分即前进：自评后等状态刷新成功再 advance；失败停留反馈页人工兜底。
  // useAnswer 的 onSuccess invalidate 已触发 /api/today 刷新，这里只消费其结果，
  // 不再显式 refetch（否则与 invalidate 叠加成两次请求）。
  useEffect(() => {
    if (!frozen?.autoAdvance) return;
    if (isError || isFetching) return;
    advance();
  }, [frozen, isError, isFetching, advance]);

  const isActive = data?.status === 'active';
  // completed + frozen：会话已结束但还在展示最后一题的作答反馈
  const showSession = isActive || frozen !== null;

  return (
    <section className="space-y-4">
      <h1 className="hidden text-lg font-semibold md:block">Today</h1>
      {isLoading && <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>}
      {isError && (
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm text-destructive">读取失败，请重试。</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            重试
          </Button>
        </div>
      )}
      {data?.status === 'idle' && !frozen && <IdleToday data={data} />}
      {showSession && (
        <ActiveSession
          progress={isActive ? data.progress : (frozen?.result.progress ?? null)}
          currentTask={isActive ? data.currentTask : null}
          frozen={frozen}
          onAnswered={setFrozen}
          onAdvance={advance}
        />
      )}
      {data?.status === 'completed' && !frozen && (
        <CompletedToday data={data} remainingNewQuota={data.remainingNewQuota ?? undefined} />
      )}
    </section>
  );
}
