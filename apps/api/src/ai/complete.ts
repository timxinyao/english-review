import { AI_RESPONSE_SCHEMAS, AI_TASK_CATALOG, type AiTask } from '@el/shared';
import type { AppConfig } from '../config.js';
import { AppError } from '../lib/errors.js';
import { checkAiOutput } from './invariants.js';
import { resolveModelForTask } from './models.js';
import type { LoadedPrompt, PromptMeta } from './promptRegistry.js';
import { renderPrompt } from './promptRegistry.js';
import { MAX_STRUCTURED_RETRIES, TASK_MODEL_POLICY, resolveThinking } from './taskConfig.js';
import type { AiProvider } from './provider/index.js';

export interface CompleteSuccess<T> {
  data: T;
  meta: PromptMeta;
  /** 本次实际使用的模型（自动发现/配置指定后的解析结果） */
  model: string;
  attempts: number;
}

export class AiStructuredError extends AppError {
  constructor(message: string) {
    super('AI_PROVIDER_ERROR', message);
    this.name = 'AiStructuredError';
  }
}

/** 从模型输出提取 JSON（容忍代码围栏与前后说明文字） */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new AiStructuredError('模型输出中未找到 JSON 对象');
  }
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    throw new AiStructuredError('模型输出 JSON 解析失败');
  }
}

export interface CompleteDeps {
  provider: AiProvider;
  config: AppConfig;
  registry: Map<string, LoadedPrompt>;
}

/**
 * 端到端预算下发起 attempt 的最小剩余时间：不足则不再重试，按失败路径返回错误。
 * ε 余量：provider 内部"仅超时重试一次"使单次 complete 最坏 2×timeoutMs，
 * 调用方按剩余预算减半裁剪 timeoutMs，故端到端总耗时 ≤ 预算 + 本常数级别的调度误差。
 */
const MIN_BUDGET_REMAINING_MS = 5_000;

/**
 * 结构化 AI 调用：渲染 Prompt → provider → JSON 提取 → Zod → 语义不变式。
 * 失败重试至多 maxRetries 次；仍失败抛 AiStructuredError，不产生脏数据。
 * 任务策略声明 totalBudgetMs 时（2026-10-04 批改 504 事故）：所有 attempt 的总耗时
 * 硬限在该预算内——剩余不足 MIN_BUDGET_REMAINING_MS 停止重试，且每次传给 provider 的
 * timeoutMs 按剩余预算减半裁剪（provider 内部还会超时重试一次，最坏 2×timeoutMs），
 * 保证端到端 ≤ 预算+ε，不撞 nginx 180s / 前端 100s 中止。
 */
export async function completeStructured<T>(
  deps: CompleteDeps,
  task: AiTask,
  vars: Record<string, unknown>,
): Promise<CompleteSuccess<T>> {
  const spec = AI_TASK_CATALOG[task];
  const schema = AI_RESPONSE_SCHEMAS[spec.responseSchemaName];
  if (!schema) throw new AiStructuredError(`未知 response_schema：${spec.responseSchemaName}`);

  const rendered = renderPrompt(deps.registry, spec.promptKey, vars);
  const policy = TASK_MODEL_POLICY[task];
  const model = await resolveModelForTask(deps.config, task);
  const budgetDeadline =
    policy.totalBudgetMs !== undefined ? Date.now() + policy.totalBudgetMs : null;

  let lastError: unknown;
  let budgetExhausted = false;
  for (let attempt = 1; attempt <= MAX_STRUCTURED_RETRIES + 1; attempt++) {
    if (budgetDeadline !== null && budgetDeadline - Date.now() < MIN_BUDGET_REMAINING_MS) {
      budgetExhausted = true;
      break;
    }
    // 预算内裁剪：provider 单次 complete 最坏耗时 2×timeoutMs（内部超时重试一次），
    // 故取 min(任务超时, 剩余/2)，使本 attempt 即使全超时也不越过 deadline
    const remaining = budgetDeadline !== null ? budgetDeadline - Date.now() : null;
    const timeoutMs =
      policy.timeoutMs !== undefined && remaining !== null
        ? Math.min(policy.timeoutMs, Math.floor(remaining / 2))
        : policy.timeoutMs;
    try {
      const raw = await deps.provider.complete({
        task,
        model,
        temperature: policy.temperature,
        thinking: resolveThinking(task, deps.config),
        prompt: rendered.text,
        vars,
        timeoutMs,
      });
      const parsed = schema.safeParse(extractJson(raw));
      if (!parsed.success) {
        throw new AiStructuredError(
          `输出不符合 Schema：${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        );
      }
      const violations = checkAiOutput(task, parsed.data, vars);
      if (violations.length > 0) {
        throw new AiStructuredError(`输出违反不变式：${violations.join('；')}`);
      }
      return { data: parsed.data as T, meta: rendered.meta, model, attempts: attempt };
    } catch (err) {
      lastError = err;
    }
  }
  throw new AiStructuredError(
    `AI 结构化调用失败（已重试 ${MAX_STRUCTURED_RETRIES} 次）${budgetExhausted ? `（端到端预算 ${policy.totalBudgetMs}ms 耗尽，提前停止重试）` : ''}：${(lastError as Error).message}`,
  );
}
