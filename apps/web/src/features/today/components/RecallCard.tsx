import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AnswerRequest, AnswerResponse, TodayTaskView } from '@el/shared';
import { Volume2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { todayKeys, useAnswer } from '../api';
import { speak } from '../../../lib/tts';

interface Props {
  task: TodayTaskView;
  result: AnswerResponse | null;
  outcomeSource: AnswerResponse['outcomeSource'];
  onAnswered: (result: AnswerResponse, opts?: { autoAdvance?: boolean }) => void;
  onAdvance: () => void;
}

/** 冻结反馈：按 outcomeSource 四态（2026-10-03 三档自评）——recalled=良好 / easy=简单
 *  （均为通过色）/ assisted=提示后想起（基础通过，历史数据）/ forgot=重来 + 正确释义与
 *  原句揭示；历史数据 outcomeSource 为空时按 result 回退：对=良好 / 错=重来 */
function RecallFeedback({
  task,
  result,
  outcomeSource,
}: {
  task: TodayTaskView;
  result: AnswerResponse | null;
  outcomeSource: AnswerResponse['outcomeSource'];
}) {
  const unknown =
    outcomeSource !== 'recalled' &&
    outcomeSource !== 'assisted' &&
    outcomeSource !== 'forgot' &&
    outcomeSource !== 'easy';
  const easy = outcomeSource === 'easy';
  const recalled = outcomeSource === 'recalled' || (unknown && result?.correct === true);
  const assisted = outcomeSource === 'assisted';
  const forgot = outcomeSource === 'forgot' || (unknown && result !== null && !result.correct);

  return (
    <div className="space-y-3">
      {recalled && <p className="text-sm text-success">良好</p>}
      {easy && <p className="text-sm text-success">简单</p>}
      {assisted && <p className="text-sm text-warning">提示后想起（基础通过）</p>}
      {forgot && <p className="text-sm text-destructive">重来</p>}
      {/* 冻结态统一保留学习内容：释义 + 原句（verdict 只作一行判语，2026-09-28 用户改版） */}
      <p className="text-sm">
        <span className="text-muted-foreground">{forgot ? '正确释义：' : '释义：'}</span>
        {forgot ? <span className="text-success">{task.item.meaning}</span> : task.item.meaning}
      </p>
      {task.sourceExample !== null && (
        <p className="study-example">
          <span className="mb-1 block text-xs text-muted-foreground">原句</span>
          {task.sourceExample}
        </p>
      )}
    </div>
  );
}

/** Understanding Recall Card：主动回忆优先（PRODUCT §7.1）。
 *  沉浸式布局：词行/学习内容滚动，作答按钮停靠底部 dock；
 *  路径统一为 看词 → 显示答案 → 三选一（2026-10-03 Anki 式三档）：揭示前仅一个全宽
 *  主按钮「显示答案」（无直判留卡分支）；揭示后 [重来][良好][简单] 三键等宽一排，
 *  均评分即前进——答案已在屏不冻结重放。frozen 分支仅刷新失败兜底与旧日/回放渲染。 */
export function RecallCard({ task, result, outcomeSource, onAnswered, onAdvance }: Props) {
  const answer = useAnswer();
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState(false);

  const frozen = result !== null;
  const word = task.item;
  const answerError =
    answer.isError && !frozen ? (
      <div role="alert" className="flex shrink-0 flex-col gap-2">
        <p className="text-sm text-destructive">{answer.error.message}</p>
        <Button
          variant="ghost"
          onClick={() => void queryClient.invalidateQueries({ queryKey: todayKeys.all })}
        >
          刷新今日学习
        </Button>
      </div>
    ) : null;

  function submit(body: AnswerRequest) {
    // 三档评分即前进：正常流不进入 frozen（§7.1）；仅刷新失败时回落冻结反馈兜底
    answer.mutate(
      { taskId: task.taskId, body },
      { onSuccess: (result) => onAnswered(result, { autoAdvance: true }) },
    );
  }

  /** 词行（含手动发音） */
  const wordRow = (
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
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {answerError}
      {/* 滚动区：词行 + 学习内容/揭示/反馈 */}
      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto pr-1" data-slot="body">
        {wordRow}

        {/* 原句默认展示（understanding 不再有"查看原句"，API 侧也不再因 viewedSource 降档） */}
        {task.sourceExample !== null && !frozen && (
          <p className="study-example">
            <span className="mb-1 block text-xs text-muted-foreground">原句</span>
            {task.sourceExample}
          </p>
        )}

        {/* 显示答案后自评（recall 直判）：meaning/notes 留在滚动区 */}
        {!frozen && revealed && (
          <div className="space-y-6 border-t border-border/70 pt-6">
            <p className="text-lg leading-relaxed text-foreground">{word.meaning}</p>
            {word.notes ? (
              <details className="text-sm" open>
                <summary className="cursor-pointer text-xs text-muted-foreground">笔记</summary>
                <p className="mt-2 whitespace-pre-line leading-7 text-muted-foreground">
                  {word.notes}
                </p>
              </details>
            ) : null}
          </div>
        )}

        {/* 冻结反馈（作答后/回看） */}
        {frozen && <RecallFeedback task={task} result={result} outcomeSource={outcomeSource} />}
      </div>

      {/* 底部 dock：作答按钮。揭示前仅一个全宽主按钮（无直判）；揭示后三档等宽一排 */}
      {!frozen && !revealed && (
        <div className="study-dock" data-slot="dock">
          <Button className="w-full" onClick={() => setRevealed(true)}>
            显示答案
          </Button>
        </div>
      )}

      {!frozen && revealed && (
        <div className="study-dock" data-slot="dock">
          <div className="grid grid-cols-3 gap-2">
            <Button
              variant="negative"
              className="flex-1"
              disabled={answer.isPending}
              onClick={() => submit({ recall: 'forgot' })}
            >
              重来
            </Button>
            <Button
              className="flex-1"
              disabled={answer.isPending}
              onClick={() => submit({ recall: 'recalled' })}
            >
              良好
            </Button>
            <Button
              variant="neutral"
              className="flex-1"
              disabled={answer.isPending}
              onClick={() => submit({ recall: 'easy' })}
            >
              简单
            </Button>
          </div>
        </div>
      )}

      {frozen && (
        <div className="study-dock flex justify-end" data-slot="dock">
          <Button onClick={onAdvance}>下一题</Button>
        </div>
      )}
    </div>
  );
}
