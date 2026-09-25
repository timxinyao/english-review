import type { TodayCompletedResponse } from '@el/shared';
import { Link } from 'react-router-dom';

/** completed 态：安静完成摘要（PRODUCT §4.3/§5.1）；recommendRead 提供 /read 入口 */
export function CompletedToday({ data }: { data: TodayCompletedResponse }) {
  const { summary } = data;

  return (
    <div className="space-y-3 py-12 text-center">
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
  );
}
