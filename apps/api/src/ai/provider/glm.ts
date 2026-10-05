import type { AppConfig } from '../../config.js';
import { THINKING_BUDGET_TOKENS } from '../taskConfig.js';
import type { AiProvider, ProviderRequest } from './index.js';

const TIMEOUT_MS = 120_000;

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** 超时（abort）标记：provider 内部据此决定是否重试 */
    readonly isTimeout = false,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** Anthropic Messages API 响应（GLM Anthropic 兼容端点） */
interface MessagesResponse {
  content?: { type: string; text?: string }[];
  error?: { type?: string; message?: string };
}

/**
 * GLM provider —— Anthropic Messages 兼容协议。
 * 端点：{GLM_API_BASE}/v1/messages。JSON 输出靠 Prompt 约束 + completeStructured 的
 * extractJson 容错；thinking 启用时响应含 thinking 块，此处只拼接 text 块。
 */
export function createGlmProvider(config: AppConfig, fetcher: typeof fetch = fetch): AiProvider {
  const baseUrl = config.glmApiBase.replace(/\/$/, '');

  /** 单次请求（不含重试）：超时抛 isTimeout 的 AiProviderError */
  const requestOnce = async (req: ProviderRequest, timeoutMs: number): Promise<string> => {
    const thinkingBudget = req.thinking === 'off' ? null : THINKING_BUDGET_TOKENS[req.thinking];
    // 思考开启时保证正文输出空间：max_tokens 至少为 预算 + 正文额度
    const maxTokens =
      thinkingBudget === null
        ? config.glmMaxTokens
        : Math.max(config.glmMaxTokens, thinkingBudget + config.glmMaxTokens);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetcher(`${baseUrl}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.glmApiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: maxTokens,
          temperature: req.temperature,
          // GLM 端点不传 thinking 时模型会"自发思考"（实测 flash 单次可自发 ~10k 字符导致 60s+ 延迟），
          // 因此 off 必须显式 disabled
          thinking:
            thinkingBudget !== null
              ? { type: 'enabled', budget_tokens: thinkingBudget }
              : { type: 'disabled' },
          messages: [{ role: 'user', content: req.prompt }],
        }),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new AiProviderError(`GLM HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
      }
      let json: MessagesResponse;
      try {
        json = JSON.parse(text) as MessagesResponse;
      } catch {
        throw new AiProviderError('GLM 响应不是合法 JSON');
      }
      if (json.error) {
        throw new AiProviderError(
          `GLM 错误 ${json.error.type ?? ''}: ${(json.error.message ?? '').slice(0, 300)}`,
        );
      }
      const content = (json.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text!)
        .join('');
      if (!content.trim()) {
        throw new AiProviderError('GLM 响应缺少文本内容');
      }
      return content;
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new AiProviderError(`GLM 请求超时（${timeoutMs}ms）`, undefined, true);
      }
      throw new AiProviderError(`GLM 请求失败：${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    name: 'glm',
    async complete(req: ProviderRequest): Promise<string> {
      // 任务级超时（2026-10-03 批改长尾收紧）：仅当失败是超时且是本次 complete 的第一次
      // 尝试时，立即重试一次（全新 AbortController）；非超时错误不重试，总尝试 ≤2——
      // 只重试一次，结构化层面的重试仍由 completeStructured 负责。
      // 端到端预算（2026-10-04 504 事故）：completeStructured 会按剩余预算减半裁剪
      // timeoutMs 后传入，因此本方法最坏耗时 2×timeoutMs ≤ 当次 attempt 的剩余预算，
      // 无需在此感知 deadline；未裁剪的任务行为不变。
      const timeoutMs = req.timeoutMs ?? TIMEOUT_MS;
      for (let attempt = 1; ; attempt++) {
        try {
          return await requestOnce(req, timeoutMs);
        } catch (err) {
          if (err instanceof AiProviderError && err.isTimeout && attempt === 1) continue;
          throw err;
        }
      }
    },
  };
}
