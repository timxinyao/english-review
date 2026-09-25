import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AiModelsResponse, Settings } from '@el/shared';
import { api } from '../../lib/api';

function fmtQuota(v: number): string {
  return v === -1 ? '不限制' : `${v} 个/天`;
}

const SOURCE_LABEL: Record<AiModelsResponse['models']['flash']['source'], string> = {
  auto: '自动选择',
  config: '配置指定',
  fallback: '内置默认',
};

const THINKING_LABEL: Record<AiModelsResponse['models']['flash']['thinking'], string> = {
  off: '思考 关',
  low: '思考 低',
  high: '思考 高',
  max: '思考 最大',
};

const ALIAS_LABEL: Array<{ alias: 'flash' | 'air'; label: string }> = [
  { alias: 'flash', label: '题目生成' },
  { alias: 'air', label: '判定与批改' },
];

function AiModelsSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['ai-models'],
    queryFn: () => api<AiModelsResponse>('/api/ai/models'),
    staleTime: 10 * 60 * 1000,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">AI 模型：加载中…</p>;
  if (isError || !data) return <p className="text-sm text-muted-foreground">AI 模型：暂不可用</p>;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">AI 模型</h2>
      <dl className="space-y-3 text-sm">
        {ALIAS_LABEL.map(({ alias, label }) => {
          const info = data.models[alias];
          return (
            <div
              key={alias}
              className="flex items-center justify-between border-b border-border pb-3"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="flex items-center gap-2">
                <span className="font-mono text-xs">{info.model}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {SOURCE_LABEL[info.source]}
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {THINKING_LABEL[info.thinking]}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="text-xs text-muted-foreground">
        {data.availableModels.length > 0
          ? `自动从 ${data.availableModels.length} 个可用模型中选择最新版本；可通过环境变量固定。`
          : '未配置 GLM_API_KEY，使用内置默认模型。'}
      </p>
    </div>
  );
}

export function SettingsPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/api/settings'),
  });

  return (
    <section className="space-y-8">
      <div className="space-y-4">
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
      </div>

      <AiModelsSection />

      <Link to="/stats" className="block text-sm text-accent hover:underline">
        查看统计（Phase 6 预览）
      </Link>
    </section>
  );
}
