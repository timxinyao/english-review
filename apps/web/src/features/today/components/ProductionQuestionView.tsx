import type {
  AnswerResponse,
  ProductionQuestionView as ProductionQuestion,
  TodayTaskView,
} from '@el/shared';
import { ProductionQuestionCard } from '../../../components/production-question-card';
import { useAnswer } from '../api';

interface Props {
  task: TodayTaskView;
  question: ProductionQuestion;
  result: AnswerResponse | null;
  onAnswered: (result: AnswerResponse) => void;
  onAdvance: () => void;
}

/**
 * 表达题（PRODUCT §7.3/§7.4）：受控中文提示 + 实时批改；
 * 渲染逻辑在全局 ProductionQuestionCard；批改失败保留输入可重试。
 */
export function ProductionQuestionView({ task, question, result, onAnswered, onAdvance }: Props) {
  const answer = useAnswer();

  const error = answer.isError && !result ? (answer.error?.message ?? '批改失败，请重试。') : null;

  return (
    <ProductionQuestionCard
      variant="today"
      question={question}
      result={result}
      pending={answer.isPending}
      error={error}
      onSubmitText={(answerText) =>
        answer.mutate({ taskId: task.taskId, body: { answerText } }, { onSuccess: onAnswered })
      }
      onCancelGrading={() => answer.cancel()}
      onGiveUp={() =>
        answer.mutate({ taskId: task.taskId, body: { giveUp: true } }, { onSuccess: onAnswered })
      }
      onAdvance={onAdvance}
    />
  );
}
