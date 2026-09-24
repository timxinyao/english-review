import type { AppConfig } from '../../config.js';
import type { AiProvider, ProviderRequest } from './index.js';

const TIMEOUT_MS = 90_000;

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  error?: { code?: number | string; message?: string };
}

export function createGlmProvider(config: AppConfig): AiProvider {
  const baseUrl = config.glmApiBase.replace(/\/$/, '');

  return {
    name: 'glm',
    async complete(req: ProviderRequest): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.glmApiKey}`,
          },
          body: JSON.stringify({
            model: req.model,
            temperature: req.temperature,
            messages: [{ role: 'user', content: req.prompt }],
            ...(config.glmJsonMode ? { response_format: { type: 'json_object' } } : {}),
          }),
        });

        const text = await res.text();
        if (!res.ok) {
          throw new AiProviderError(`GLM HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
        }
        let json: ChatCompletionResponse;
        try {
          json = JSON.parse(text) as ChatCompletionResponse;
        } catch {
          throw new AiProviderError('GLM 响应不是合法 JSON');
        }
        if (json.error) {
          throw new AiProviderError(
            `GLM 错误 ${json.error.code ?? ''}: ${(json.error.message ?? '').slice(0, 300)}`,
          );
        }
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new AiProviderError('GLM 响应缺少 message.content');
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
