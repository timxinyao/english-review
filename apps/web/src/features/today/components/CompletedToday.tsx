import type { SessionTaskEntry, TodayCompletedResponse } from '@el/shared';
import { Check, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../../../lib/utils';
import { useSessionTasks } from '../api';
import { TYPE_LABEL } from './ActiveSession';

/** 排序权重：答错 0 < 答对 1 < 已撤销 2 */
function reviewWeight(e: SessionTaskEntry): number {
  if (e.canceled) return 2;
  return e.result && !e.result.correct ? 0 : 1;
}

/** completed 态：安静完成摘要（PRODUCT §4.3/§5.1）+ 今日回顾列表（错题前置，点击进 Library 可练） */
export function CompletedToday({ data }: { data: TodayCompletedResponse }) {
  const { summary } = data;
  const { data: sessionTasks } = useSessionTasks();
  const entries = [...(sessionTasks?.tasks ?? [])].sort((a, b) => reviewWeight(a) - reviewWeight(b));

  return (
    <div className="space-y-4 py-12">
      <div className="space-y-3 text-center">
        <h2 className="text-xl font-semibold text-foreground">今天完成了</h2>
        <p className="text-sm text-muted-foreground">
          共完成 {summary.totalTasks} 个任务 · 新学 {summary.newItemsStarted} 项
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
      </div>

      {entries.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-medium text-foreground">今日回顾</h3>
          <ul aria-label="今日回顾" className="space-y-1">
            {entries.map((e) => {
              const status = e.canceled
                ? '已撤销'
                : e.result
                  ? e.result.correct
                    ? '对'
                    : '错'
                  : '未做';
              return (
                <li key={e.task.taskId}>
                  <Link
                    to={`/library/${e.task.item.id}`}
                    className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-muted"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="text-foreground">{e.task.item.target}</span>
                      <span className="text-xs text-muted-foreground/60">
                        {TYPE_LABEL[e.task.taskType]}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'flex items-center gap-1 text-xs',
                        e.result?.correct
                          ? 'text-success'
                          : e.result
                            ? 'text-destructive'
                            : 'text-muted-foreground',
                      )}
                    >
                      {e.result ? (
                        e.result.correct ? (
                          <Check className="h-3 w-3" aria-hidden />
                        ) : (
                          <X className="h-3 w-3" aria-hidden />
                        )
                      ) : null}
                      {status}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
