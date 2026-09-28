import type {
  AnswerResponse,
  ChoiceQuestionView as ChoiceQuestion,
  TodayTaskView,
} from '@el/shared';
import { ChoiceQuestionCard } from '../../../components/choice-question-card';
import { useAnswer, useTaskFeedback } from '../api';

interface Props {
  task: TodayTaskView;
  question: ChoiceQuestion;
  /** 冻结的作答结果（null = 尚未作答） */
  result: AnswerResponse | null;
  onAnswered: (result: AnswerResponse) => void;
  onAdvance: () => void;
}

/** 理解题（含 Learn 卡首题）：PRODUCT §7.1/§7.6；渲染逻辑在全局 ChoiceQuestionCard */
export function ChoiceQuestionView({ task, question, result, onAnswered, onAdvance }: Props) {
  const answer = useAnswer();
  const feedback = useTaskFeedback();

  // learn 卡已直接展示原句，无需“查看原句”，答错也不重复揭示
  const sourceExample = task.taskType === 'learn' ? null : task.sourceExample;

  return (
    <ChoiceQuestionCard
      variant="today"
      question={question}
      target={task.item.target}
      result={result}
      pending={answer.isPending}
      sourceExample={sourceExample}
      onSubmitOption={(optionId, meta) =>
        answer.mutate(
          {
            taskId: task.taskId,
            body: {
              selectedOptionId: optionId,
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
      onFeedback={(kind) =>
        feedback.mutate({ taskId: task.taskId, feedback: kind }, { onSuccess: onAdvance })
      }
    />
  );
}
