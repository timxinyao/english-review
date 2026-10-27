import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { useSessionTasks, useTodayStatus } from './api';
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
  // 与 ActiveSession 共享同一 react-query 缓存（按 key 去重，不产生额外请求）；
  // idle 无会话（/api/today/tasks 会 409）故按状态门控
  const { data: sessionTasks } = useSessionTasks(
    data?.status === 'active' || data?.status === 'completed',
  );
  const [frozen, setFrozen] = useState<FrozenAnswer | null>(null);
  const advance = useCallback(() => setFrozen(null), []);

  /**
   * 后台批改完成回 App 先看结果（2026-10-05）：造句提交后若页面不在场
   * （onSuccess 展示反馈的正常路径未走到），记录 taskId；之后任一批量视图
   * 刷新（主场景：回前台 visibilitychange invalidate）落地时该任务已有
   * result，则组装 FrozenAnswer（无 autoAdvance）交给现有冻结反馈渲染——
   * 用户先看判分/diff/更自然说法，点「下一题」才前进。任务仍未结算时保持
   * pending 等待（现有行为）。仅内存态：刷新页面不追（结果永远可在
   * 「今日学习」只读弹层回看）。
   */
  const unseenGradingRef = useRef<string | null>(null);
  useEffect(() => {
    const taskId = unseenGradingRef.current;
    if (!taskId) return;
    const entry = sessionTasks?.tasks.find((e) => e.task.taskId === taskId);
    if (!entry || entry.canceled || entry.result === null) return;
    unseenGradingRef.current = null;
    setFrozen({ task: entry.task, result: entry.result });
  }, [sessionTasks]);

  /** 造句提交即挂账（不等 onSuccess：切后台后 fetch 可能被冻结/掐断） */
  const handleSubmitted = useCallback((taskId: string) => {
    unseenGradingRef.current = taskId;
  }, []);
  /** 反馈已展示（页面在场的正常路径）：清除挂账 */
  const handleAnswered = useCallback((f: FrozenAnswer) => {
    unseenGradingRef.current = null;
    setFrozen(f);
  }, []);

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
    <section className={cn('mx-auto max-w-[680px] space-y-5', !showSession && 'pb-40 md:pb-0')}>
      <h1 className="hidden text-lg font-semibold md:block">Today</h1>
      {isLoading && (
        <div className="space-y-8" aria-busy="true" aria-label="加载中">
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <div className="mx-auto h-4 w-48 animate-pulse rounded bg-muted" />
            <div className="mx-auto mt-3 h-3 w-32 animate-pulse rounded bg-muted" />
            <div className="mx-auto mt-5 h-12 w-40 animate-pulse rounded-lg bg-muted" />
            <div className="mx-auto mt-3 h-3 w-44 animate-pulse rounded bg-muted" />
          </div>
          <div className="space-y-2">
            <div className="h-3 w-28 animate-pulse rounded bg-muted" />
            <div className="h-10 animate-pulse rounded bg-muted/70" />
            <div className="h-10 animate-pulse rounded bg-muted/70" />
          </div>
        </div>
      )}
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
          onAnswered={handleAnswered}
          onSubmitted={handleSubmitted}
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
