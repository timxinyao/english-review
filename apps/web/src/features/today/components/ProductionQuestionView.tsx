import type {
  AnswerResponse,
  ProductionQuestionView as ProductionQuestion,
  TodayTaskView,
} from '@el/shared';
import { ApiError } from '../../../lib/api';
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
 * 渲染逻辑在全局 ProductionQuestionCard；批改失败保留输入可重试（弹窗文案按错误码分支）。
 */
export function ProductionQuestionView({ task, question, result, onAnswered, onAdvance }: Props) {
  const answer = useAnswer();

  const error = answer.isError && !result ? (answer.error?.message ?? '批改失败，请重试。') : null;
  const errorCode =
    answer.isError && !result && answer.error instanceof ApiError ? answer.error.code : null;

  return (
    <ProductionQuestionCard
      variant="today"
      question={question}
      result={result}
      pending={answer.isPending}
      error={error}
      errorCode={errorCode}
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
