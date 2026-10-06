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
 * "批改中…"。150s > 批改端到端预算 120s+ε（apps/api taskConfig totalBudgetMs，
 * 2026-10-06 思考纪律 v3 后疑难句中位 ~48s、单次上限 60s），不误伤慢批改；
 * 回前台时被冻结的定时器恢复并立即触发 abort。
 */
const REQUEST_TIMEOUT_MS = 150_000;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  // 外部 signal（如造句批改「取消」掐断请求）桥接进内部 controller：
  // 任一先触发都中止 fetch；用 timedOut 区分——只有自身超时才报「请求超时」，
  // 外部 abort 原样抛 AbortError，由调用方决定文案与状态清理。
  const external = init?.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort);
  }
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
    if ((err as { name?: string } | null)?.name === 'AbortError' && timedOut) {
      throw new ApiError('REQUEST_TIMEOUT', '请求超时，请重试', 0);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
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
