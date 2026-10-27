/**
 * Today 沉浸式会话态信号：ActiveSession 挂载时打开，shell 据此收敛手机顶栏
 * （藏刷新/Stats），避免与 ProgressRow 形成双顶栏挤压。
 */
import { useEffect, useState } from 'react';

type Listener = (active: boolean) => void;

const listeners = new Set<Listener>();
let immersiveActive = false;

export function setTodayImmersiveSession(active: boolean): void {
  if (immersiveActive === active) return;
  immersiveActive = active;
  for (const listener of listeners) listener(active);
}

/** 当前是否处于 Today 一题一屏会话（含完成前最后一题反馈冻结） */
export function useTodayImmersiveSession(): boolean {
  const [active, setActive] = useState(immersiveActive);
  useEffect(() => {
    listeners.add(setActive);
    setActive(immersiveActive);
    return () => {
      listeners.delete(setActive);
    };
  }, []);
  return active;
}
