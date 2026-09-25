import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AiModelsResponse, Settings } from '@el/shared';
import { api } from '../../lib/api';
import { BackupSection } from './components/BackupSection';

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
  medium: '思考 中',
  high: '思考 高',
  max: '思考 最大',
};

const TASK_LABEL: Record<string, string> = {
  generateUnderstandingQuestions: '理解题生成',
  generateClozeQuestions: '填空题生成',
  generateProductionPrompt: '表达题生成',
  generateRead: 'Read 生成',
  checkProduction: '表达批改',
  checkCloze: '填空兜底判定',
  judgeDuplicateMeaning: '导入重复判定',
};

interface ModelRow {
  key: string;
  usage: string;
  model: string;
  source: AiModelsResponse['models']['flash']['source'];
  thinking: AiModelsResponse['models']['flash']['thinking'];
}

/** 按实际任务矩阵动态分组：模型+思考相同的任务合并一行（跟随 taskConfig，不写死用途） */
function groupTaskMapping(data: AiModelsResponse): ModelRow[] {
  const groups = new Map<string, { usage: string[]; alias: string; model: string; thinking: string }>();
  for (const t of data.taskMapping) {
    const key = `${t.alias}|${t.model}|${t.thinking}`;
    const g = groups.get(key) ?? { usage: [], alias: t.alias, model: t.model, thinking: t.thinking };
    g.usage.push(TASK_LABEL[t.task] ?? t.task);
    groups.set(key, g);
  }
  return [...groups.entries()].map(([key, g]) => ({
    key,
    usage: g.usage.join(' · '),
    model: g.model,
    source: data.models[g.alias as 'flash' | 'air' | 'max']?.source ?? 'auto',
    thinking: g.thinking as ModelRow['thinking'],
  }));
}

function AiModelsSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['ai-models'],
    queryFn: () => api<AiModelsResponse>('/api/ai/models'),
    staleTime: 10 * 60 * 1000,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">AI 模型：加载中…</p>;
  if (isError || !data) return <p className="text-sm text-muted-foreground">AI 模型：暂不可用</p>;

  const rows = groupTaskMapping(data);
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">AI 模型</h2>
      <dl className="space-y-3 text-sm">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-3 border-b border-border pb-3">
            <dt className="text-muted-foreground">{row.usage}</dt>
            <dd className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-xs">{row.model}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {SOURCE_LABEL[row.source]}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {THINKING_LABEL[row.thinking]}
              </span>
            </dd>
          </div>
        ))}
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
        <p className="text-xs text-muted-foreground">设置编辑将在后续阶段提供。</p>
      </div>

      <AiModelsSection />

      <BackupSection />

      <Link to="/stats" className="block text-sm text-accent hover:underline">
        查看统计
      </Link>
    </section>
  );
}
