/**
 * Web Push 载荷纯逻辑（sw.ts 与单测共用——sw.ts 走 tsconfig.sw.json 的 WebWorker lib
 * 无法直接进主程序测试，故决策逻辑抽到本模块，保持零 DOM/WebWorker 依赖）：
 * - grading：造句批改完成 {title, body, url}；
 * - self-test：订阅即自检多带 test:true，SW 端绕过前台静默恒弹（用户订阅瞬间必在前台，
 *   静默逻辑会吞掉自检弹窗，恒弹才能让用户点开可见、证明端到端链路通）。
 */
export interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  test?: boolean;
}

/** push event.data.text() → 载荷；空/非 JSON 载荷回退空对象（默认标题 + /today） */
export function parsePushPayload(raw: string | null | undefined): PushPayload {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as PushPayload;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 是否弹通知：test 自检恒弹；批改通知任一可见窗口即静默（用户正看着结果卡） */
export function shouldShowNotification(payload: PushPayload, hasVisibleWindow: boolean): boolean {
  if (payload.test === true) return true;
  return !hasVisibleWindow;
}

/** 通知 tag：自检与批改互不替换（同 tag 才覆盖，自检混入会顶掉真实批改通知） */
export function notificationTag(payload: PushPayload): 'push-selftest' | 'grading' {
  return payload.test === true ? 'push-selftest' : 'grading';
}
