import { useCallback, useState } from 'react';
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
  const { data, isLoading, isError, refetch } = useTodayStatus();
  const [frozen, setFrozen] = useState<FrozenAnswer | null>(null);
  const advance = useCallback(() => setFrozen(null), []);

  const isActive = data?.status === 'active';
  // completed + frozen：会话已结束但还在展示最后一题的作答反馈
  const showSession = isActive || frozen !== null;

  return (
    <section className="space-y-4">
      <h1 className="text-lg font-semibold">Today</h1>
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
      {data?.status === 'completed' && !frozen && <CompletedToday data={data} />}
    </section>
  );
}
