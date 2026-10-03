import { useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AnswerResponse, TodayTaskView } from '@el/shared';
import { Volume2 } from 'lucide-react';
import { ChoiceQuestionView } from './ChoiceQuestionView';
import { ClozeQuestionView } from './ClozeQuestionView';
import { ProductionQuestionView } from './ProductionQuestionView';
import { RecallCard } from './RecallCard';
import { Button } from '../../../components/ui/button';
import { todayKeys, useLater, usePrepareTask } from '../api';
import { speak } from '../../../lib/tts';

/**
 * 占位卡：仍依赖绑定题的任务（production；历史 cloze 展示路径）。已知内容（词行+原句）
 * 即时渲染，加载态只在 dock 一行低调提示——不占正文中央大空白（2026-10-03 反白屏）。
 * 理解/learn 不进这里：RecallCard 不消费绑定题，question=null 直接渲染。
 * 稍后再做仅在生成失败的 dock 出现；in-flight 期间绝不提供。
 */
function PendingQuestion({ task }: { task: TodayTaskView }) {
  const prepare = usePrepareTask();
  const later = useLater();
  const queryClient = useQueryClient();
  const started = useRef(false);
  const taskId = task.taskId;
  const { mutate } = prepare;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate(taskId);
  }, [taskId, mutate]);

  const word = task.item;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 滚动区：已知内容（与 RecallCard 同版式的词行 + 原句） */}
      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto pr-1" data-slot="body">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pr-9">
          <h3 className="study-title min-w-0">{word.target}</h3>
          {word.type === 'word' && word.ipa !== null && (
            <span className="text-sm text-muted-foreground">{word.ipa}</span>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="发音"
            onClick={() => void speak(word.target, { userGesture: true })}
          >
            <Volume2 className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        {task.sourceExample !== null && (
          <p className="study-example">
            <span className="mb-1 block text-xs text-muted-foreground">原句</span>
            {task.sourceExample}
          </p>
        )}
        {prepare.isError && (
          <p role="alert" className="text-sm text-destructive">
            {prepare.error.message}
          </p>
        )}
      </div>
      {later.isError && (
        <p role="alert" className="mt-2 shrink-0 text-sm text-destructive">
          {later.error.message}
        </p>
      )}
      <div className="study-dock" data-slot="dock">
        {prepare.isError ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => mutate(taskId)}>重试</Button>
            <Button
              variant="neutral"
              disabled={later.isPending}
              onClick={() => later.mutate(taskId)}
            >
              稍后再做
            </Button>
            <Button
              variant="ghost"
              onClick={() => void queryClient.invalidateQueries({ queryKey: todayKeys.all })}
            >
              刷新今日学习
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
              正在准备…
            </p>
            {later.isError && (
              <Button
                variant="ghost"
                onClick={() => void queryClient.invalidateQueries({ queryKey: todayKeys.all })}
              >
                刷新今日学习
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface Props {
  task: TodayTaskView;
  /** 已作答时冻结的任务 + 结果（用于展示反馈，直到 advance） */
  result: AnswerResponse | null;
  /** 卡片右上角插槽：撤销最近一次作答的单图标（PRODUCT §5.1；无可撤销作答时不传入） */
  undoControl?: ReactNode;
  onAnswered?: (result: AnswerResponse, opts?: { autoAdvance?: boolean }) => void;
  onAdvance?: () => void;
}

/**
 * 单张任务卡：按题型渲染题目。坏题入口不在卡面——2026-09-28 起只在
 * 「今日学习」的具体作答记录上标记（PRODUCT §4.2/§6.5）；顺序回看已删除，
 * 历史作答一律进只读弹层。卡片右上角为撤销最近一次作答的单图标（区别于坏题）。
 */
export function TaskCard({ task, result, undoControl, onAnswered, onAdvance }: Props) {
  const question = task.question;

  return (
    <article className="study-card relative flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card p-5 pt-8 sm:p-8 sm:pt-10">
      {/* 右上角撤销图标：悬浮于卡角（答错冻结头行已留 pr-12 避让） */}
      {undoControl && <div className="absolute right-3 top-3">{undoControl}</div>}
      {/* 已答冻结：顶部显示考的单词（learn/understanding 由 RecallCard 自带词行，不重复） */}
      {result !== null && task.taskType !== 'learn' && task.taskType !== 'understanding' && (
        <div className="mb-3 flex shrink-0 items-baseline gap-2 pr-12">
          <h3 className="study-title min-w-0">{task.item.target}</h3>
          {task.item.type === 'word' && task.item.ipa !== null && (
            <span className="text-sm text-muted-foreground">{task.item.ipa}</span>
          )}
        </div>
      )}

      {/* 理解题（learn 新词 + understanding 复习）：Recall Card——主动回忆优先，直判/显示答案两条路。
          卡面内容全部来自 task.item，不消费绑定题：question=null 也直接渲染（2026-10-03 起不再
          为 U 触发 prepare，消除评分即前进切卡时的白板闪现）；占位卡只留给依赖题面的任务 */}
      {!question && (task.taskType === 'understanding' || task.taskType === 'learn') ? (
        <RecallCard
          task={task}
          result={result}
          outcomeSource={result?.outcomeSource ?? null}
          onAnswered={onAnswered ?? (() => {})}
          onAdvance={onAdvance ?? (() => {})}
        />
      ) : !question ? (
        <PendingQuestion task={task} />
      ) : 'options' in question ? (
        task.taskType === 'understanding' || task.taskType === 'learn' ? (
          <RecallCard
            task={task}
            result={result}
            outcomeSource={result?.outcomeSource ?? null}
            onAnswered={onAnswered ?? (() => {})}
            onAdvance={onAdvance ?? (() => {})}
          />
        ) : (
          <ChoiceQuestionView
            task={task}
            question={question}
            result={result}
            onAnswered={onAnswered ?? (() => {})}
            onAdvance={onAdvance ?? (() => {})}
          />
        )
      ) : question && 'textWithBlank' in question ? (
        <ClozeQuestionView
          task={task}
          question={question}
          result={result}
          onAnswered={onAnswered ?? (() => {})}
          onAdvance={onAdvance ?? (() => {})}
        />
      ) : question && 'zhPrompt' in question ? (
        <ProductionQuestionView
          task={task}
          question={question}
          result={result}
          onAnswered={onAnswered ?? (() => {})}
          onAdvance={onAdvance ?? (() => {})}
        />
      ) : null}
    </article>
  );
}
