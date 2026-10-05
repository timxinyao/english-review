/** 唯一 fetch 封装（docs/ARCHITECTURE.md §3.3） */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/**
 * 全局请求超时：iOS 切后台会冻结进行中的 fetch Promise，回前台若不中止则永远
 * "批改中…"。100s > 批改端到端预算 80s+ε（apps/api taskConfig totalBudgetMs），
 * 不误伤慢批改；回前台时被冻结的定时器恢复并立即触发 abort。
 */
const REQUEST_TIMEOUT_MS = 100_000;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'include',
      ...init,
      signal: controller.signal,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    // abort 无 status（请求未收到响应），用 status=0 表达；其余网络错误原样抛出。
    // 不用 instanceof Error：jsdom 等环境的 DOMException 不继承 Error
    if ((err as { name?: string } | null)?.name === 'AbortError') {
      throw new ApiError('REQUEST_TIMEOUT', '请求超时，请重试', 0);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let code = 'UNKNOWN';
    let message = `请求失败（${res.status}）`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // 保持默认错误信息
    }
    throw new ApiError(code, message, res.status);
  }
  return (await res.json()) as T;
}
