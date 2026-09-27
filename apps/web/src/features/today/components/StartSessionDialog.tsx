import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ElapsedTimer } from '../../../components/elapsed-timer';
import { Button } from '../../../components/ui/button';

interface Props {
  pending: boolean;
  errorMessage: string | null;
  onRetry: () => void;
  onDismiss: () => void;
}

/** 开始会话期间的全屏等待/失败弹窗（DEVELOPMENT §7：portal 到 body + z-overlay） */
export function StartSessionDialog({ pending, errorMessage, onRetry, onDismiss }: Props) {
  // 计时起点 = 组件挂载时刻（IdleToday 已改为条件挂载，挂载即等待开始）
  const [startedAt] = useState(() => Date.now());
  if (!pending && !errorMessage) return null;
  return createPortal(
    <div
      role="dialog"
      aria-label="开始今日复习"
      className="fixed inset-0 z-overlay flex items-center justify-center bg-foreground/20"
    >
      <div className="mx-5 w-full max-w-[340px] rounded-xl border border-border bg-card p-5 text-center">
        {pending ? (
          <>
            <p className="text-sm font-medium text-foreground">正在准备今日题目…</p>
            <p className="mt-1 text-xs text-muted-foreground">
              已等待 <ElapsedTimer since={startedAt} />，首次生成约需一分钟
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-destructive">开始失败</p>
            <p className="mt-2 text-xs text-muted-foreground">{errorMessage}</p>
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="ghost" size="sm" onClick={onDismiss}>
                关闭
              </Button>
              <Button size="sm" onClick={onRetry}>
                重试
              </Button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
