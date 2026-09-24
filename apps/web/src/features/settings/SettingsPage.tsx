import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Settings } from '@el/shared';
import { api } from '../../lib/api';

function fmtQuota(v: number): string {
  return v === -1 ? '不限制' : `${v} 个/天`;
}

export function SettingsPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/api/settings'),
  });

  return (
    <section className="space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      {isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
      {isError && <p className="text-sm text-destructive">读取失败，请刷新重试。</p>}
      {data && (
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <dt className="text-muted-foreground">每日新学习项上限</dt>
            <dd>{fmtQuota(data.maxNewItemsPerDay)}</dd>
          </div>
          <div className="flex items-center justify-between border-b border-border pb-3">
            <dt className="text-muted-foreground">内容难度</dt>
            <dd>{data.contentLevel}</dd>
          </div>
        </dl>
      )}
      <p className="text-xs text-muted-foreground">
        设置编辑、导入导出与备份恢复将在后续阶段提供。
      </p>
      <Link to="/stats" className="block text-sm text-accent hover:underline">
        查看统计（Phase 6 预览）
      </Link>
    </section>
  );
}
