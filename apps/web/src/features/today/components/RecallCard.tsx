import { useState } from 'react';
import type {
  AnswerRequest,
  AnswerResponse,
  ChoiceQuestionView as ChoiceQuestion,
  TodayTaskView,
} from '@el/shared';
import { Volume2 } from 'lucide-react';
import { ChoiceQuestionCard } from '../../../components/choice-question-card';
import { Button } from '../../../components/ui/button';
import { useAnswer } from '../api';
import { speak } from '../../../lib/tts';

interface Props {
  task: TodayTaskView;
  question: ChoiceQuestion;
  result: AnswerResponse | null;
  outcomeSource: AnswerResponse['outcomeSource'];
  readOnly?: boolean;
  onAnswered: (result: AnswerResponse, opts?: { autoAdvance?: boolean }) => void;
  onAdvance: () => void;
}

/** 冻结反馈：按 outcomeSource 三态——recalled=想起来了 / assisted=提示后想起（基础通过）/
 *  forgot=没想起来 + 正确释义与原句揭示；历史数据 outcomeSource 为空时按 result 回退：
 *  对=想起来了 / 错=没想起来 / 无 result 的只读回看=中性（仅 meaning，不显示判定文案） */
function RecallFeedback({
  task,
  result,
  outcomeSource,
}: {
  task: TodayTaskView;
  result: AnswerResponse | null;
  outcomeSource: AnswerResponse['outcomeSource'];
}) {
  const unknown = outcomeSource !== 'recalled' && outcomeSource !== 'assisted' && outcomeSource !== 'forgot';
  const recalled = outcomeSource === 'recalled' || (unknown && result?.correct === true);
  const assisted = outcomeSource === 'assisted';
  const forgot = outcomeSource === 'forgot' || (unknown && result !== null && !result.correct);

  return (
    <div className="space-y-3">
      {recalled && <p className="text-sm text-success">想起来了</p>}
      {assisted && (
        <p className="text-sm text-warning">提示后想起（基础通过）</p>
      )}
      {forgot && <p className="text-sm text-destructive">没想起来</p>}
      {/* 冻结态统一保留学习内容：释义 + 原句（verdict 只作一行判语，2026-09-28 用户改版） */}
      <p className="text-sm">
        <span className="text-muted-foreground">{forgot ? '正确释义：' : '释义：'}</span>
        {forgot ? <span className="text-success">{task.item.meaning}</span> : task.item.meaning}
      </p>
      {task.sourceExample !== null && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">原句</span>
          {task.sourceExample}
        </p>
      )}
    </div>
  );
}

/** Understanding Recall Card：主动回忆优先（PRODUCT §7.1）；选择题降级为 Hint。
 *  沉浸式布局：词行/学习内容滚动，作答按钮停靠底部 dock；
 *  「想起来了」自评通过保留评分即前进，「没想起来」/主动不会留在当前卡（§7.6）。 */
export function RecallCard({
  task,
  question,
  result,
  outcomeSource,
  readOnly,
  onAnswered,
  onAdvance,
}: Props) {
  const answer = useAnswer();
  const [revealed, setRevealed] = useState(false);
  const [hint, setHint] = useState(false);

  const frozen = result !== null || readOnly;
  const word = task.item;
  // Hint 路径的冻结（提交过选项或主动不会）：复用选择题统一纠错（勾正确项/错选项+理由）
  const choiceFrozen = result !== null && (result.selectedOptionId !== null || result.gaveUp === true);

  function submit(body: AnswerRequest, opts?: { autoAdvance?: boolean }) {
    answer.mutate({ taskId: task.taskId, body }, { onSuccess: (result) => onAnswered(result, opts) });
  }

  /** 词行（含手动发音） */
  const wordRow = (
    <div className="flex items-center gap-2">
      <h3 className="text-lg font-semibold text-foreground">{word.target}</h3>
      {word.type === 'word' && word.ipa !== null && (
        <span className="text-sm text-muted-foreground">{word.ipa}</span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground"
        aria-label="发音"
        onClick={() => void speak(word.target, { userGesture: true })}
      >
        <Volume2 className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );

  if (hint) {
    // Hint 态：词行置顶，选择题（today 版式）自带滚动题干与底部选项停靠；
    // 冻结时判语/释义/原句由 RecallFeedback 呈现，选项勾选纠错由选择题统一版式呈现
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 pb-3">{wordRow}</div>
        {frozen && (
          <div className="shrink-0 space-y-4 pb-3">
            <RecallFeedback task={task} result={result} outcomeSource={outcomeSource} />
          </div>
        )}
        <ChoiceQuestionCard
          variant="today"
          question={question}
          target={word.target}
          result={result}
          pending={answer.isPending}
          hideVerdict={choiceFrozen}
          onSubmitOption={(optionId) => submit({ selectedOptionId: optionId, hintUsed: true })}
          onGiveUp={frozen ? undefined : () => submit({ giveUp: true })}
          onAdvance={onAdvance}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 滚动区：词行 + 学习内容/揭示/反馈 */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto" data-slot="body">
        {wordRow}

        {/* 原句默认展示（understanding 不再有"查看原句"，API 侧也不再因 viewedSource 降档） */}
        {task.sourceExample !== null && !frozen && (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
            <span className="mr-1 text-xs text-muted-foreground">原句</span>
            {task.sourceExample}
          </p>
        )}

        {/* 显示答案后自评（recall 直判）：meaning/notes 留在滚动区 */}
        {!frozen && revealed && (
          <div className="space-y-3">
            <p className="text-base text-foreground">{word.meaning}</p>
            {word.notes ? (
              <details className="text-sm" open>
                <summary className="text-xs text-muted-foreground cursor-pointer">笔记</summary>
                <p className="mt-1 text-muted-foreground">{word.notes}</p>
              </details>
            ) : null}
          </div>
        )}

        {/* 冻结反馈（作答后/回看） */}
        {frozen && <RecallFeedback task={task} result={result} outcomeSource={outcomeSource} />}
      </div>

      {/* 底部 dock：作答按钮 */}
      {!frozen && !revealed && (
        <div className="mt-3 shrink-0 space-y-2 border-t border-border pt-3" data-slot="dock">
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setRevealed(true)}
            >
              显示答案
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              disabled={answer.isPending}
              onClick={() => submit({ recall: 'forgot' })}
            >
              没想起来
            </Button>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setHint(true)}>
            给我提示
          </Button>
        </div>
      )}

      {!frozen && revealed && (
        <div className="mt-3 shrink-0 space-y-2 border-t border-border pt-3" data-slot="dock">
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              disabled={answer.isPending}
              onClick={() => submit({ recall: 'forgot' })}
            >
              没想起来
            </Button>
            <Button
              className="flex-1"
              disabled={answer.isPending}
              onClick={() => submit({ recall: 'recalled' }, { autoAdvance: true })}
            >
              想起来了
            </Button>
          </div>
        </div>
      )}

      {frozen && (
        <div className="mt-3 flex shrink-0 justify-end border-t border-border pt-3" data-slot="dock">
          <Button onClick={onAdvance}>下一题</Button>
        </div>
      )}
    </div>
  );
}
