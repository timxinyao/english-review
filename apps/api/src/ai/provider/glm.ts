import type { AppConfig } from '../../config.js';
import { THINKING_BUDGET_TOKENS } from '../taskConfig.js';
import type { AiProvider, ProviderRequest } from './index.js';

const TIMEOUT_MS = 120_000;

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
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

  return {
    name: 'glm',
    async complete(req: ProviderRequest): Promise<string> {
      const thinkingBudget = req.thinking === 'off' ? null : THINKING_BUDGET_TOKENS[req.thinking];
      // 思考开启时保证正文输出空间：max_tokens 至少为 预算 + 正文额度
      const maxTokens =
        thinkingBudget === null
          ? config.glmMaxTokens
          : Math.max(config.glmMaxTokens, thinkingBudget + config.glmMaxTokens);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
            ...(thinkingBudget !== null
              ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } }
              : {}),
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
          throw new AiProviderError(`GLM 请求超时（${TIMEOUT_MS}ms）`);
        }
        throw new AiProviderError(`GLM 请求失败：${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
