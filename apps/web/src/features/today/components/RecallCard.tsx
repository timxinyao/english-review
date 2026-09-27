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
  /** Hint 用的四选一（任务绑定题目） */
  question: ChoiceQuestion;
  result: AnswerResponse | null;
  outcomeSource: AnswerResponse['outcomeSource'];
  readOnly?: boolean;
  onAnswered: (result: AnswerResponse) => void;
  onAdvance: () => void;
}

/** 冻结反馈：按 outcomeSource 三态——recalled=想起来了 / assisted=提示后想起（基础通过）/
 *  forgot=没想起来 + 正确释义与原句揭示；历史数据 outcomeSource 为空时按 result 回退：
 *  对=想起来了 / 错=没想起来 / 无 result 的只读回看=中性（仅 meaning，不显示判定文案） */
function RecallFeedback({
  task,
  result,
  outcomeSource,
  readOnly,
  onAdvance,
}: {
  task: TodayTaskView;
  result: AnswerResponse | null;
  outcomeSource: AnswerResponse['outcomeSource'];
  readOnly?: boolean;
  onAdvance: () => void;
}) {
  const unknown = outcomeSource !== 'recalled' && outcomeSource !== 'assisted' && outcomeSource !== 'forgot';
  const neutral = unknown && result === null && readOnly === true;
  const recalled = outcomeSource === 'recalled' || (unknown && result?.correct === true);
  const assisted = outcomeSource === 'assisted';
  const forgot = outcomeSource === 'forgot' || (unknown && result !== null && !result.correct);

  return (
    <div className="space-y-3">
      {recalled && <p className="text-sm text-success">想起来了</p>}
      {assisted && (
        <p className="text-sm text-muted-foreground">提示后想起（基础通过）</p>
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
      <div className="flex justify-end">
        <Button onClick={onAdvance}>下一题</Button>
      </div>
    </div>
  );
}

/** Understanding Recall Card：主动回忆优先（PRODUCT §7.1 改版）；选择题降级为 Hint */
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

  function submit(body: AnswerRequest) {
    answer.mutate({ taskId: task.taskId, body }, { onSuccess: onAnswered });
  }

  return (
    <div className="space-y-4">
      {/* 词行（含手动发音） */}
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

      {/* 提示态：原句默认展示（understanding 不再有"查看原句"，API 侧也不再因 viewedSource 降档）；
          hint 态隐藏——ChoiceQuestionCard 的 context 已带源句，避免同屏重复 */}
      {task.sourceExample !== null && !frozen && !hint && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">原句</span>
          {task.sourceExample}
        </p>
      )}

      {/* 作答态 1：主动回忆入口 */}
      {!frozen && !hint && !revealed && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setHint(true)}>
            给我提示
          </Button>
          <Button size="sm" onClick={() => setRevealed(true)}>
            显示答案
          </Button>
        </div>
      )}

      {/* 作答态 2：显示答案后自评（recall 直判） */}
      {!frozen && !hint && revealed && (
        <div className="space-y-3">
          <p className="text-base text-foreground">{word.meaning}</p>
          {word.notes ? (
            <details className="text-sm" open>
              <summary className="text-xs text-muted-foreground cursor-pointer">笔记</summary>
              <p className="mt-1 text-muted-foreground">{word.notes}</p>
            </details>
          ) : null}
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
              onClick={() => submit({ recall: 'recalled' })}
            >
              想起来了
            </Button>
          </div>
        </div>
      )}

      {/* Hint：复用选择题（仅答题形态：result=null、不传 onFeedback/sourceExample） */}
      {!frozen && hint && (
        <ChoiceQuestionCard
          question={question}
          target={word.target}
          result={null}
          pending={answer.isPending}
          onSubmitOption={(optionId) =>
            submit({ selectedOptionId: optionId, hintUsed: true })
          }
          onAdvance={onAdvance}
        />
      )}

      {/* 冻结反馈（作答后/回看） */}
      {frozen && (
        <RecallFeedback
          task={task}
          result={result}
          outcomeSource={outcomeSource}
          readOnly={readOnly}
          onAdvance={onAdvance}
        />
      )}
    </div>
  );
}
