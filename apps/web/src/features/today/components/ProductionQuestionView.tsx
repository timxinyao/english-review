import type {
  AnswerResponse,
  ProductionQuestionView as ProductionQuestion,
  TodayTaskView,
} from '@el/shared';
import { ApiError } from '../../../lib/api';
import { ProductionQuestionCard } from '../../../components/production-question-card';
import { ScrambleQuestionCard } from '../../../components/scramble-question-card';
import { useAnswer } from '../api';

interface Props {
  task: TodayTaskView;
  question: ProductionQuestion;
  result: AnswerResponse | null;
  onAnswered: (result: AnswerResponse) => void;
  /** 提交即回调（不等批改结果）：TodayPage 挂账未见反馈的造句，回前台刷新后补看 */
  onSubmitted?: (taskId: string) => void;
  onAdvance: () => void;
}

function isScramble(
  q: ProductionQuestion,
): q is Extract<ProductionQuestion, { kind: 'scramble' }> {
  return 'kind' in q && q.kind === 'scramble';
}

/**
 * 表达题：scramble_v1 走拼词卡；迁移期仍兼容旧打字造句视图。
 */
export function ProductionQuestionView({
  task,
  question,
  result,
  onAnswered,
  onSubmitted,
  onAdvance,
}: Props) {
  const answer = useAnswer();

  const error = answer.isError && !result ? (answer.error?.message ?? '批改失败，请重试。') : null;
  const errorCode =
    answer.isError && !result && answer.error instanceof ApiError ? answer.error.code : null;

  if (isScramble(question)) {
    return (
      <ScrambleQuestionCard
        variant="today"
        question={question}
        result={result}
        pending={answer.isPending}
        error={error}
        onSubmitTokens={(selectedTokens) => {
          onSubmitted?.(task.taskId);
          answer.mutate(
            { taskId: task.taskId, body: { selectedTokens } },
            { onSuccess: onAnswered },
          );
        }}
        onGiveUp={() => {
          onSubmitted?.(task.taskId);
          answer.mutate({ taskId: task.taskId, body: { giveUp: true } }, { onSuccess: onAnswered });
        }}
        onAdvance={onAdvance}
      />
    );
  }

  return (
    <ProductionQuestionCard
      variant="today"
      question={question}
      result={result}
      pending={answer.isPending}
      error={error}
      errorCode={errorCode}
      onSubmitText={(answerText) => {
        onSubmitted?.(task.taskId);
        answer.mutate({ taskId: task.taskId, body: { answerText } }, { onSuccess: onAnswered });
      }}
      onCancelGrading={() => answer.cancel()}
      onGiveUp={() => {
        onSubmitted?.(task.taskId);
        answer.mutate({ taskId: task.taskId, body: { giveUp: true } }, { onSuccess: onAnswered });
      }}
      onAdvance={onAdvance}
    />
  );
}
