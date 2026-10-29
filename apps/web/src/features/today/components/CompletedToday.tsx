import { useState } from 'react';
import { EXTEND_BATCH_UNLIMITED, type TodayCompletedResponse } from '@el/shared';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/ui/button';
import { TodayLearningList } from './TodayLearningSheet';
import { UndoAnswerControl } from './UndoAnswer';
import { useExtendSession, useSessionTasks } from '../api';

/**
 * completed 态：安静完成摘要（PRODUCT §4.3/§5.1）+ 再学一批（§3.4）
 * + 「今日学习」默认折叠，点开才看全日记录（手机降压）。
 */
export function CompletedToday({
  data,
  remainingNewQuota,
}: {
  data: TodayCompletedResponse;
  /** 剩余新学额度：null=不限制（不限批默认 10），0=用尽无按钮 */
  remainingNewQuota?: number | null;
}) {
  const { summary } = data;
  const { data: sessionTasks } = useSessionTasks();
  const entries = sessionTasks?.tasks ?? [];
  const undoableTaskId = sessionTasks?.undoableTaskId ?? null;
  const extend = useExtendSession();
  const extendCount = Math.min(data.newQueueCount, remainingNewQuota ?? EXTEND_BATCH_UNLIMITED);
  const [showLog, setShowLog] = useState(false);

  function renderExtend() {
    if (!(extendCount > 0)) return null;
    if (extend.isSuccess) return null; // invalidate 后组件将卸载，双保险
    return (
      <div className="space-y-1">
        <Button size="sm" disabled={extend.isPending} onClick={() => extend.mutate()}>
          {extend.isPending ? '正在追加…' : `再学 ${extendCount} 个新词`}
        </Button>
        {extend.isError && (
          <p className="text-xs text-destructive">
            {(extend.error as Error | undefined)?.message || '追加失败，请重试'}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-4 pb-12">
      <div className="space-y-3 text-center">
        <h2 className="text-xl font-semibold text-foreground">今天完成了</h2>
        <p className="text-sm text-muted-foreground">
          词库剩余 {data.newQueueCount} 词待学 · 共 {data.totalItems} 词
        </p>
        <p className="text-sm text-muted-foreground">
          通过 {summary.pass} · 基础通过 {summary.basicPass} · 未通过 {summary.fail}
        </p>
        {summary.recommendRead && (
          <p className="text-sm text-muted-foreground">
            <Link to="/read" className="text-accent underline-offset-2 hover:underline">
              生成一篇 Read 复现今日内容
            </Link>
          </p>
        )}
        {renderExtend()}

        {/* 完成页保留最近一次作答的撤销入口（PRODUCT §5.1）；撤销后服务端重新激活会话 */}
        <div className="flex justify-center">
          <UndoAnswerControl undoableTaskId={undoableTaskId} entries={entries} />
        </div>
      </div>

      {entries.length > 0 && (
        <section className="space-y-1.5">
          {!showLog ? (
            <div className="flex justify-center">
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowLog(true)}>
                查看今日记录
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground">今日学习</h3>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowLog(false)}>
                  收起
                </Button>
              </div>
              <TodayLearningList entries={entries} />
            </>
          )}
        </section>
      )}
    </div>
  );
}
