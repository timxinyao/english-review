import { useCallback, useEffect, useState } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { useTodayStatus } from './api';
import { ActiveSession, type FrozenAnswer } from './components/ActiveSession';
import { CompletedToday } from './components/CompletedToday';
import { IdleToday } from './components/IdleToday';

/**
 * Today：产品核心页，按 GET /api/today 三态渲染（idle / active / completed）。
 * 作答反馈冻结在页面级：最后一题答完即使状态已翻转为 completed，
 * 仍先展示该题反馈，advance 后才进入完成摘要。
 * 活动会话为沉浸式一题一屏（§5.1）：无页级底部留白，卡自身占满可用高度；
 * 非 会话 态补回 shell 让出的移动端底部留白。
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
  // 评分即前进的刷新窗口：不渲染旧卡反馈页（防"下一题"页面闪现），占位到切卡；失败时回落反馈页
  const advancing = frozen?.autoAdvance === true && !isError;

  /**
   * 撤销最近一次作答成功（PRODUCT §5.1）：撤的就是当前冻结反馈那题时，
   * 借用评分即前进的刷新窗口——冻结反馈即刻让位（不重开已撤销的揭示题），
   * 等 today 查询 invalidate/refetch 落地后再由服务端 currentTask 接管；
   * 撤的是其他题（如另一设备更新的作答）时当前反馈仍有效，不前进。
   */
  const handleUndone = useCallback((taskId: string) => {
    setFrozen((f) => (f && f.task.taskId === taskId ? { ...f, autoAdvance: true } : f));
  }, []);

  return (
    <section className={cn('space-y-4', !showSession && 'pb-40 md:pb-0')}>
      <h1 className="hidden text-lg font-semibold md:block">Today</h1>
      {isLoading && <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>}
      {isError && (
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm text-destructive">读取失败，请重试。</p>
          <Button variant="neutral" size="sm" onClick={() => void refetch()}>
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
          advancing={advancing}
          onAnswered={setFrozen}
          onAdvance={advance}
          onUndone={handleUndone}
        />
      )}
      {data?.status === 'completed' && !frozen && (
        <CompletedToday data={data} remainingNewQuota={data.remainingNewQuota ?? undefined} />
      )}
    </section>
  );
}
