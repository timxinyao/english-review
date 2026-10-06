import { createHash } from 'node:crypto';
import { AI_TASKS, type AiModelsResponse, type AiTask } from '@el/shared';
import type { AppConfig } from '../config.js';
import {
  TASK_MODEL_POLICY,
  providerSlotForTask,
  resolveThinking,
  type ModelAlias,
} from './taskConfig.js';

/**
 * 模型自动发现与覆盖（TECHNICAL_DESIGN §10.5）：
 * 1. 环境变量非空 → 使用指定值（source=config）；
 * 2. 留空 → GET /v1/models 自动选择：flash=版本最高 *flash*，air/max=版本最高无后缀主模型；
 * 3. 无 key / 发现失败 → fallback 常量，不阻塞启动。
 */

export const FALLBACK_MODELS: Record<ModelAlias, string> = {
  flash: 'glm-5.3-flash',
  air: 'glm-5.3',
  max: 'glm-5.3',
};

/** 解析 "glm-5.3-flash" → [5,3]；非 glm 型号返回 null */
export function parseModelVersion(id: string): number[] | null {
  const m = /^glm-(\d+(?:\.\d+)*)/.exec(id);
  if (!m) return null;
  return m[1]!.split('.').map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 版本最高的 `*flash*` 型号；同版本取名字更短者（-flash 优先于 -flashx） */
export function pickFlashModel(ids: string[]): string | null {
  const candidates = ids.filter((id) => /flash/i.test(id) && parseModelVersion(id));
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => {
    const cmp = compareVersions(parseModelVersion(a)!, parseModelVersion(b)!);
    if (cmp !== 0) return cmp;
    // 同版本：长名排前，最后一位（被选中）即更短名
    return b.length - a.length;
  })[candidates.length - 1]!;
}

/** 版本最高的无后缀主模型（glm-X.Y 形式） */
export function pickMainModel(ids: string[]): string | null {
  const candidates = ids.filter((id) => /^glm-\d+(\.\d+)*$/.test(id));
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => compareVersions(parseModelVersion(a)!, parseModelVersion(b)!))[
    candidates.length - 1
  ]!;
}

export interface ResolvedModelInfo {
  model: string;
  source: 'auto' | 'config' | 'fallback';
  inList: boolean;
}

export interface ResolvedModels {
  models: Record<ModelAlias, ResolvedModelInfo>;
  availableModels: string[];
  checkedAt: string | null;
}

/** 纯函数：给定配置（别名可空串=自动）与可用清单，得出各别名解析结果 */
export function resolveModelConfig(
  glmModels: AppConfig['glmModels'],
  availableIds: string[],
  checkedAt: Date | null,
): ResolvedModels {
  const list = new Set(availableIds);
  const resolve = (
    alias: ModelAlias,
    autoPick: (ids: string[]) => string | null,
  ): ResolvedModelInfo => {
    const explicit = glmModels[alias].trim();
    if (explicit) {
      return { model: explicit, source: 'config', inList: list.has(explicit) };
    }
    if (availableIds.length === 0) {
      return { model: FALLBACK_MODELS[alias], source: 'fallback', inList: false };
    }
    const picked = autoPick(availableIds) ?? FALLBACK_MODELS[alias];
    return { model: picked, source: 'auto', inList: true };
  };

  return {
    models: {
      flash: resolve('flash', pickFlashModel),
      air: resolve('air', pickMainModel),
      max: resolve('max', pickMainModel),
    },
    availableModels: availableIds,
    checkedAt: checkedAt ? checkedAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// 发现 + 进程内缓存（每 provider 槽一份：主槽 GLM_* / 后台槽 AI_BG_*）
// ---------------------------------------------------------------------------

/** 一个 provider 槽的连接配置（从 AppConfig 切片，两个槽同构） */
export interface ProviderSlotConfig {
  glmApiKey?: string;
  glmApiBase: string;
  glmModels: { flash: string; air: string; max: string };
}

interface ModelsCacheEntry {
  key: string;
  promise: Promise<ResolvedModels>;
  fetchedAt: number;
  resolved: ResolvedModels | null;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 成功：1 小时
const FAILURE_TTL_MS = 60 * 1000; // 失败：60 秒后重试
/** 每槽一条缓存（主槽/后台槽独立发现与失效），key = 槽配置 hash */
const caches = new Map<string, ModelsCacheEntry>();

interface ModelsEndpointResponse {
  data?: { id?: string }[];
}

/** 拉取可用模型清单（失败返回 []；fetcher 可注入供测试） */
export async function fetchAvailableModels(
  config: ProviderSlotConfig,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  if (!config.glmApiKey) return [];
  const base = config.glmApiBase.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetcher(`${base}/v1/models`, {
      signal: controller.signal,
      headers: {
        'x-api-key': config.glmApiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as ModelsEndpointResponse;
    return (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function slotCacheKey(slot: ProviderSlotConfig): string {
  return createHash('sha256')
    .update(`${slot.glmApiKey ?? ''}|${slot.glmApiBase}|${JSON.stringify(slot.glmModels)}`)
    .digest('hex');
}

/** 解析一个槽的生效模型（带 TTL 缓存；配置变化即失效） */
export function getResolvedModelsFor(slot: ProviderSlotConfig): Promise<ResolvedModels> {
  const key = slotCacheKey(slot);
  const now = Date.now();
  const cached = caches.get(key);
  const fresh =
    cached &&
    now - cached.fetchedAt <
      (cached.resolved && cached.resolved.availableModels.length > 0
        ? CACHE_TTL_MS
        : FAILURE_TTL_MS);
  if (fresh && cached) return cached.promise;

  const entry: ModelsCacheEntry = {
    key,
    fetchedAt: now,
    resolved: null,
    promise: fetchAvailableModels(slot).then((ids) => {
      const resolved = resolveModelConfig(slot.glmModels, ids, ids.length ? new Date() : null);
      entry.resolved = resolved;
      return resolved;
    }),
  };
  caches.set(key, entry);
  return entry.promise;
}

/** 主槽配置切片（GLM_*：实时任务，当前指向 DeepSeek） */
export function mainSlot(config: AppConfig): ProviderSlotConfig {
  return { glmApiKey: config.glmApiKey, glmApiBase: config.glmApiBase, glmModels: config.glmModels };
}

/** 后台槽配置切片（AI_BG_*：批量任务，当前指向 GLM 免费套餐） */
export function backgroundSlot(config: AppConfig): ProviderSlotConfig {
  return { glmApiKey: config.aiBgApiKey, glmApiBase: config.aiBgApiBase, glmModels: config.aiBgModels };
}

/** 兼容旧签名：主槽解析（routes /api/ai/models 的 models 字段） */
export function getResolvedModels(config: AppConfig): Promise<ResolvedModels> {
  return getResolvedModelsFor(mainSlot(config));
}

/** 给任务取解析后的模型（completeStructured / eval 使用）：按任务策略路由槽 */
export async function resolveModelForTask(config: AppConfig, task: AiTask): Promise<string> {
  const slot =
    providerSlotForTask(task, config) === 'background' ? backgroundSlot(config) : mainSlot(config);
  const resolved = await getResolvedModelsFor(slot);
  return resolved.models[TASK_MODEL_POLICY[task].alias].model;
}

/** GET /api/ai/models 响应构建（不含 endpoint/密钥） */
export async function buildAiModelsResponse(config: AppConfig): Promise<AiModelsResponse> {
  const resolved = await getResolvedModels(config);
  const aliasThinking = (alias: ModelAlias): 'off' | 'low' | 'medium' | 'high' | 'max' => {
    const task = (Object.keys(TASK_MODEL_POLICY) as AiTask[]).find(
      (t) => TASK_MODEL_POLICY[t].alias === alias,
    );
    // 无任务使用该别名（如 max）时：仅显示全局强制值，否则 off
    return task ? resolveThinking(task, config) : (config.glmThinking ?? 'off');
  };
  const withThinking = (alias: ModelAlias) => ({
    ...resolved.models[alias],
    thinking: aliasThinking(alias),
  });
  return {
    provider: config.glmApiKey ? 'glm' : 'glm(unconfigured)',
    models: {
      flash: withThinking('flash'),
      air: withThinking('air'),
      max: withThinking('max'),
    },
    backgroundConfigured: Boolean(config.aiBgApiKey),
    thinkingOverride: config.glmThinking,
    taskMapping: await Promise.all(
      AI_TASKS.map(async (task) => ({
        task,
        alias: TASK_MODEL_POLICY[task].alias,
        model: await resolveModelForTask(config, task),
        thinking: resolveThinking(task, config),
        provider: providerSlotForTask(task, config),
      })),
    ),
    availableModels: resolved.availableModels,
    checkedAt: resolved.checkedAt,
  };
}

/** 测试辅助：清空缓存 */
export function clearModelsCacheForTests(): void {
  caches.clear();
}
