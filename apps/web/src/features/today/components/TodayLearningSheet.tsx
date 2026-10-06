import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionTaskEntry, TodayTaskView } from '@el/shared';
import { ThumbsDown } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils';
import { useBadQuestion } from '../api';

export const TYPE_LABEL: Record<TodayTaskView['taskType'], string> = {
  learn: 'learn',
  understanding: '理解',
  cloze: '填空',
  production: '表达',
};

// ---------- 纯派生：只读记录展示 ----------

export interface TodayItemGroup {
  item: TodayTaskView['item'];
  entries: SessionTaskEntry[];
}

/** 按 Learning Item 去重分组（首次出现顺序），同 item 多题共用一组（PRODUCT §5.1） */
export function groupByItem(entries: SessionTaskEntry[]): TodayItemGroup[] {
  const groups = new Map<string, TodayItemGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.task.item.id);
    if (existing) existing.entries.push(entry);
    else groups.set(entry.task.item.id, { item: entry.task.item, entries: [entry] });
  }
  return [...groups.values()];
}

function choiceOptionText(task: TodayTaskView, optionId: string | null): string | null {
  const question = task.question;
  if (optionId === null || !question || !('options' in question)) return null;
  return question.options.find((o) => o.id === optionId)?.text ?? null;
}

/** 记录题面摘要：选择题题干 / 填空句面 / 表达中文提示 */
function questionSnippetOf(task: TodayTaskView): string | null {
  const question = task.question;
  if (!question) return null;
  if ('options' in question) return question.question;
  if ('textWithBlank' in question) return question.textWithBlank;
  return question.zhPrompt;
}

/** 本次作答展示：选项文本 / 作答文本 / 「不会」/ Recall 自评；未作答与已撤销为 null */
function submittedAnswerOf(entry: SessionTaskEntry): string | null {
  const { task, result, canceled } = entry;
  if (canceled || !result) return null;
  if (result.gaveUp) return '不会';
  const option = choiceOptionText(task, result.selectedOptionId);
  if (option !== null) return option;
  if (result.submittedAnswerText !== null && result.submittedAnswerText !== '') {
    return result.submittedAnswerText;
  }
  if (result.outcomeSource === 'recalled') return '良好';
  if (result.outcomeSource === 'easy') return '简单';
  if (result.outcomeSource === 'assisted') return '提示后想起';
  if (result.outcomeSource === 'forgot') return '重来';
  return null;
}

/** 正确答案展示：选择题正确项 / 填空可接受答案 / 表达参考句（主动不会）或纠错句 */
function correctAnswerOf(entry: SessionTaskEntry): string | null {
  const { task, result } = entry;
  if (!result) return null;
  const question = task.question;
  if (question && 'options' in question) return choiceOptionText(task, result.correctOptionId);
  if (question && 'textWithBlank' in question) {
    return result.acceptedAnswer ?? result.completeSentence ?? null;
  }
  if (question && 'zhPrompt' in question) {
    return result.referenceAnswer ?? result.correction?.correctedSentence ?? null;
  }
  return null;
}

// ---------- 展示组件 ----------

const TRACK_LABEL = {
  pass: '对',
  basic_pass: '基础',
  fail: '错',
  pending: '未做',
  canceled: '撤销',
} as const;

const TRACK_CLASS = {
  pass: 'text-success',
  basic_pass: 'text-warning',
  fail: 'text-destructive',
  pending: 'text-muted-foreground',
  canceled: 'text-muted-foreground/70',
} as const;

function entryTrackKind(entry: SessionTaskEntry): keyof typeof TRACK_LABEL {
  if (entry.canceled) return 'canceled';
  if (!entry.result) return 'pending';
  return entry.result.result;
}

/** 分组头内的结果轨迹：每次作答一枚文字徽标（不只靠颜色） */
function ResultTrack({ entries }: { entries: SessionTaskEntry[] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-x-1 gap-y-0.5">
      {entries.map((entry) => {
        const kind = entryTrackKind(entry);
        return (
          <span
            key={entry.task.taskId}
            className={cn('rounded bg-muted px-1 py-px text-[10px] leading-4', TRACK_CLASS[kind])}
          >
            {TRACK_LABEL[kind]}
          </span>
        );
      })}
    </span>
  );
}

/** 单条作答记录（只读）：题面 / 作答 / 正确答案 / 解释；已完成记录可标记坏题（§6.5） */
function RecordRow({ entry }: { entry: SessionTaskEntry }) {
  const badQuestion = useBadQuestion();
  const [confirmBad, setConfirmBad] = useState(false);
  const { task, result, canceled } = entry;
  const snippet = questionSnippetOf(task);
  const submitted = submittedAnswerOf(entry);
  const correct = correctAnswerOf(entry);
  const kind = entryTrackKind(entry);
  const verdict =
    kind === 'canceled'
      ? '已撤销'
      : kind === 'pending'
        ? '未作答'
        : kind === 'pass'
          ? '通过'
          : kind === 'basic_pass'
            ? '基础通过'
            : '未通过';
  const originSuffix = task.origin === 'reinforcement' ? ' · 补强' : '';

  return (
    <li className="space-y-1.5 rounded-lg bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {TYPE_LABEL[task.taskType]}
          {originSuffix}
        </span>
        <span className={cn('text-xs', TRACK_CLASS[kind])}>{verdict}</span>
      </div>
      {snippet !== null && <p className="text-sm text-foreground">{snippet}</p>}
      {submitted !== null && (
        <p className="text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">作答</span>
          <span>{submitted}</span>
        </p>
      )}
      {correct !== null && (
        <p className="text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">正确答案</span>
          <span>{correct}</span>
        </p>
      )}
      {result?.correction?.betterVersion && (
        <p className="text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">
            {result.correction.betterVersionKind === 'rewrite' ? '参考表达' : '更自然的说法'}
          </span>
          <span>{result.correction.betterVersion}</span>
        </p>
      )}
      {result?.explanation != null && (
        <p className="text-sm text-muted-foreground">{result.explanation}</p>
      )}

      {/* 坏题入口在具体作答记录上（PRODUCT §4.2/§6.5）；未作答/已撤销无记录可失效 */}
      {!canceled &&
        result !== null &&
        (confirmBad ? (
          <div
            role="dialog"
            aria-label="标记坏题"
            className="flex items-center justify-between gap-2 pt-0.5"
          >
            <span className="text-xs text-muted-foreground">标记坏题将撤销本次作答影响</span>
            <span className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  badQuestion.reset();
                  setConfirmBad(false);
                }}
              >
                取消
              </Button>
              <Button
                size="sm"
                disabled={badQuestion.isPending}
                onClick={() =>
                  badQuestion.mutate(task.taskId, { onSuccess: () => setConfirmBad(false) })
                }
              >
                确定
              </Button>
            </span>
          </div>
        ) : (
          <div className="flex justify-end pt-0.5">
            <Button variant="ghost" size="sm" onClick={() => setConfirmBad(true)}>
              <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
              坏题
            </Button>
          </div>
        ))}
      {badQuestion.isError && (
        <p className="text-xs text-destructive">
          {(badQuestion.error as Error | undefined)?.message || '标记失败，请重试'}
        </p>
      )}
    </li>
  );
}

/** 单个学习项分组：词/词块 + IPA（仅 Word）+ 释义 + 结果轨迹；展开只读记录 */
function ItemGroup({ group }: { group: TodayItemGroup }) {
  const [open, setOpen] = useState(false);
  const { item, entries } = group;
  return (
    <li className="rounded-lg border border-border">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-2 p-3 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">{item.target}</span>
            {item.type === 'word' && item.ipa !== null && (
              <span className="shrink-0 text-xs text-muted-foreground">{item.ipa}</span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {item.meaning}
          </span>
        </span>
        <ResultTrack entries={entries} />
      </button>
      {open && (
        <ul className="space-y-2 border-t border-border p-3">
          {entries.map((entry) => (
            <RecordRow key={entry.task.taskId} entry={entry} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** 今日学习列表：按学习项去重的只读记录（active 弹层与完成页共用；不用于跳题/回看/重答） */
export function TodayLearningList({ entries }: { entries: SessionTaskEntry[] }) {
  const groups = useMemo(() => groupByItem(entries), [entries]);
  if (groups.length === 0) return null;
  return (
    <ul aria-label="今日学习" className="space-y-2">
      {groups.map((group) => (
        <ItemGroup key={group.item.id} group={group} />
      ))}
    </ul>
  );
}

/** 「今日学习」底部弹层：点击进度打开；关闭回到原当前题（弹层不改变当前卡） */
export function TodayLearningSheet({
  entries,
  onClose,
}: {
  entries: SessionTaskEntry[];
  onClose: () => void;
}) {
  return createPortal(
    <div
      role="dialog"
      aria-label="今日学习"
      className="fixed inset-0 z-overlay flex items-end justify-center bg-foreground/20"
      onClick={onClose}
    >
      <div
        className="max-h-[70vh] w-full max-w-[420px] overflow-y-auto rounded-t-xl border-t border-border bg-card p-4 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">今日学习</p>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">按学习项汇总今日作答，只读回看</p>
        <TodayLearningList entries={entries} />
      </div>
    </div>,
    document.body,
  );
}
