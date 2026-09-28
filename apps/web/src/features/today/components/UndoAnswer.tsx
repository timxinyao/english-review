import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionTaskEntry } from '@el/shared';
import { Undo2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { todayKeys, useUndoAnswer } from '../api';
import { TYPE_LABEL } from './TodayLearningSheet';

const RESULT_LABEL: Record<'pass' | 'basic_pass' | 'fail', string> = {
  pass: '通过',
  basic_pass: '基础通过',
  fail: '未通过',
};

/** 打开确认层时快照的目标（词/题型/结果）：确认的请求与看到的题目严格一致 */
interface UndoTarget {
  taskId: string;
  word: string | null;
  typeLabel: string | null;
  resultLabel: string | null;
}

/**
 * 单图标「撤销最近一次作答」（PRODUCT §5.1）：
 * - 目标永远取服务端 GET /api/today/tasks 的 undoableTaskId（另一设备有更新作答时自动指向新者），
 *   不使用任何本地缓存的旧 id；
 * - 确认层写明将撤销的词、题型和结果；取消不发请求；确认恰好一次；
 * - 409（另一设备已作答 / 新例句已被固定编辑等）与可重试错误都在确认层内解释：
 *   失败即刷新 today 查询回服务端真态（不清掉其他设备的作答，仅展示），
 *   「暂时没有可用新题」保持确认按钮可用允许重试；
 * - 与坏题（「今日学习」记录上标记）互不影响，此处不改题目状态。
 */
export function UndoAnswerControl({
  undoableTaskId,
  entries,
  onUndone,
}: {
  /** 服务端给出的最近一次可撤销作答；null（无作答/已撤销/跨天）时整个入口隐藏 */
  undoableTaskId: string | null;
  entries: SessionTaskEntry[] | null;
  /** 撤销成功回调（TodayPage 清冻结反馈并等 refetch 落地后再展示队列） */
  onUndone?: (taskId: string) => void;
}): ReactNode {
  const undo = useUndoAnswer();
  const qc = useQueryClient();
  const [target, setTarget] = useState<UndoTarget | null>(null);

  if (undoableTaskId === null) return null;
  // 收窄后的服务端目标 id：闭包内始终使用它（绝不退回本地缓存的旧 id）
  const serverUndoableId = undoableTaskId;

  function openConfirm() {
    // 上一次失败的信息不带到新开的确认层（目标可能已换题）
    undo.reset();
    const entry = (entries ?? []).find((e) => e.task.taskId === serverUndoableId);
    setTarget(
      entry
        ? {
            taskId: serverUndoableId,
            word: entry.task.item.target,
            typeLabel: TYPE_LABEL[entry.task.taskType],
            resultLabel: entry.result ? RESULT_LABEL[entry.result.result] : null,
          }
        : { taskId: serverUndoableId, word: null, typeLabel: null, resultLabel: null },
    );
  }

  function confirmUndo() {
    const id = target?.taskId ?? serverUndoableId;
    undo.mutate(id, {
      onSuccess: () => {
        setTarget(null);
        onUndone?.(id);
      },
      onError: () => {
        // 409/可重试错误：刷新回服务端真态（undoableTaskId 与分布随 refetch 更新），
        // 错误信息留在确认层内解释；数据不作本地清除
        void qc.invalidateQueries({ queryKey: todayKeys.all });
      },
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground"
        aria-label="撤销最近一次作答"
        onClick={openConfirm}
      >
        <Undo2 className="h-4 w-4" aria-hidden />
      </Button>

      {target !== null &&
        createPortal(
          <div
            role="dialog"
            aria-label="撤销最近一次作答"
            aria-modal="true"
            className="fixed inset-0 z-overlay flex items-center justify-center bg-foreground/20 p-4"
            onClick={() => {
              if (!undo.isPending) setTarget(null);
            }}
          >
            <div
              className="w-full max-w-[340px] space-y-3 rounded-xl border border-border bg-card p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-sm font-medium text-foreground">撤销最近一次作答？</p>
              {target.word !== null ? (
                <p className="text-sm text-foreground">
                  将撤销 <span className="font-medium">{target.word}</span>
                  <span className="text-muted-foreground">
                    （{target.typeLabel}题 · 结果：{target.resultLabel}）
                  </span>
                </p>
              ) : (
                <p className="text-sm text-foreground">将撤销最近一次作答</p>
              )}
              <p className="text-xs text-muted-foreground">
                撤销后本题会另排一道不同的新题重练；与标记坏题互不影响。
              </p>
              {undo.isError && (
                <p className="text-xs text-destructive" role="alert">
                  {(undo.error as Error | undefined)?.message ?? '撤销失败，请重试'}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={undo.isPending}
                  onClick={() => setTarget(null)}
                >
                  取消
                </Button>
                <Button size="sm" disabled={undo.isPending} onClick={confirmUndo}>
                  {undo.isPending ? '撤销中…' : '撤销'}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
