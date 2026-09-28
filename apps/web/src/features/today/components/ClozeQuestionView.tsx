import type { AnswerResponse, ClozeQuestionView as ClozeQuestion, TodayTaskView } from '@el/shared';
import { ClozeQuestionCard } from '../../../components/cloze-question-card';
import { useAnswer } from '../api';

interface Props {
  task: TodayTaskView;
  question: ClozeQuestion;
  result: AnswerResponse | null;
  onAnswered: (result: AnswerResponse) => void;
  onAdvance: () => void;
}

/** 填空题：渲染逻辑在全局 ClozeQuestionCard；对错均手动下一题（PRODUCT §7.6） */
export function ClozeQuestionView({ task, question, result, onAnswered, onAdvance }: Props) {
  const answer = useAnswer();

  return (
    <ClozeQuestionCard
      variant="today"
      question={question}
      result={result}
      pending={answer.isPending}
      sourceExample={task.sourceExample}
      onSubmitText={(text, meta) =>
        answer.mutate(
          {
            taskId: task.taskId,
            body: {
              answerText: text,
              ...(meta.viewedSource ? { viewedSource: true } : {}),
            },
          },
          { onSuccess: onAnswered },
        )
      }
      onGiveUp={() =>
        answer.mutate(
          { taskId: task.taskId, body: { giveUp: true } },
          { onSuccess: onAnswered },
        )
      }
      onAdvance={onAdvance}
    />
  );
}
