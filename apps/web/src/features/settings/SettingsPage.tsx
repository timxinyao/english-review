import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiModelsResponse, Settings, UpdateSettingsRequest } from '@el/shared';
import { ChevronDown } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Select } from '../../components/ui/select';
import { BackupSection } from './components/BackupSection';
import { NotificationSection } from './components/NotificationSection';

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
  const groups = new Map<
    string,
    { usage: string[]; alias: string; model: string; thinking: string }
  >();
  for (const t of data.taskMapping) {
    const key = `${t.alias}|${t.model}|${t.thinking}`;
    const g = groups.get(key) ?? {
      usage: [],
      alias: t.alias,
      model: t.model,
      thinking: t.thinking,
    };
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
  // 手机默认折叠成一行「当前模型」；桌面同样可点开（Quiet UI）
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => (data ? groupTaskMapping(data) : []), [data]);
  const primaryModel = rows[0]?.model ?? data?.models.flash.model ?? '—';

  if (isLoading) return <p className="text-sm text-muted-foreground">AI 模型：加载中…</p>;
  if (isError || !data) return <p className="text-sm text-muted-foreground">AI 模型：暂不可用</p>;

  return (
    <div className="space-y-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="space-y-0.5">
          <span className="block text-sm font-semibold">AI 模型</span>
          {!expanded && (
            <span className="block text-sm text-muted-foreground">
              当前模型 <span className="font-mono text-xs text-foreground">{primaryModel}</span>
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      {expanded && (
        <>
          <dl className="space-y-3 text-sm">
            {rows.map((row) => (
              <div
                key={row.key}
                className="flex items-center justify-between gap-3 border-b border-border pb-3"
              >
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
        </>
      )}
    </div>
  );
}

const QUOTA_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '5', label: '5 个/天' },
  { value: '10', label: '10 个/天' },
  { value: '15', label: '15 个/天' },
  { value: '20', label: '20 个/天' },
  { value: '-1', label: '不限制' },
];

/** 今日复习上限（PRODUCT §5.5，2026-10-27）：Session 创建时到期复习题入队上限 */
const PLAN_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '10', label: '10 题/天' },
  { value: '15', label: '15 题/天' },
  { value: '20', label: '20 题/天' },
  { value: '30', label: '30 题/天' },
  { value: '-1', label: '不限制' },
];

const LEVEL_OPTIONS = ['A2', 'B1', 'B2', 'C1'] as const;

function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/api/settings'),
  });
  const [saved, setSaved] = useState(false);

  const update = useMutation({
    mutationFn: (patch: UpdateSettingsRequest) =>
      api<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: (next) => {
      qc.setQueryData(['settings'], next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    },
  });

  return (
    <section className="space-y-8">
      <div className="space-y-4">
        <h1 className="hidden text-lg font-semibold md:block">Settings</h1>
        {isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
        {isError && <p className="text-sm text-destructive">读取失败，请刷新重试。</p>}
        {data && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
              <span className="text-muted-foreground">每日新学习项上限</span>
              <div className="flex items-center gap-2">
                <Select
                  aria-label="每日新学习项上限"
                  value={String(data.maxNewItemsPerDay)}
                  disabled={update.isPending}
                  onChange={(e) => update.mutate({ maxNewItemsPerDay: Number(e.target.value) })}
                >
                  {QUOTA_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
              <span className="text-muted-foreground">今日复习上限</span>
              <div className="flex items-center gap-2">
                <Select
                  aria-label="今日复习上限"
                  value={String(data.todayReviewLimit)}
                  disabled={update.isPending}
                  onChange={(e) => update.mutate({ todayReviewLimit: Number(e.target.value) })}
                >
                  {PLAN_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
              <span className="text-muted-foreground">内容难度</span>
              <Select
                aria-label="内容难度"
                value={data.contentLevel}
                disabled={update.isPending}
                onChange={(e) =>
                  update.mutate({ contentLevel: e.target.value as Settings['contentLevel'] })
                }
              >
                {LEVEL_OPTIONS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              新学上限限制每天从 New Queue 引入的新词；今日复习上限限制开始复习时一次入队的到期复习题，超出的保持积压、之后每天自动安排。
              {update.isError && <span className="text-destructive"> 保存失败，请重试。</span>}
              {saved && <span className="text-success"> 已保存</span>}
            </p>
          </div>
        )}
      </div>

      <AiModelsSection />

      <NotificationSection />

      <BackupSection />

      <Link to="/stats" className="block text-sm text-accent hover:underline">
        查看统计
      </Link>

      {/* 低调入口：iOS 主屏 PWA 无地址栏，/tokens 色卡页由此可达 */}
      <Link to="/tokens" className="block text-xs text-muted-foreground hover:underline">
        设计色卡
      </Link>

      <p className="pt-2 text-[11px] text-muted-foreground/70">
        构建 {formatBuildTime(__BUILD_TIME__)}
      </p>
    </section>
  );
}
