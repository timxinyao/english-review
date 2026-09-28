import type { CorrectionView } from '@el/shared';

/**
 * Today 作答（AnswerResponse）与 Library 练一下（PracticeAnswerResponse）
 * 共用的结果展示子集——共享题型卡只消费这些字段。
 * Phase 8 起可选携带 Today 专属揭示字段（主动不会/提交内容回放）；
 * 练一下响应无这些键，按 undefined 处理即回落到原行为。
 */
export interface QuestionAnswerResult {
  result: 'pass' | 'basic_pass' | 'fail';
  correct: boolean;
  explanation: string | null;
  correctOptionId: string | null;
  completeSentence: string | null;
  acceptedAnswer: string | null;
  correction: CorrectionView | null;
  personalExampleSaved: boolean;
  /** 主动不会（Today 专属，§7.6）：按 fail 结算且未提交任何答案 */
  gaveUp?: boolean;
  /** 本次提交的选项（选择题答错标记用；主动不会为 null） */
  selectedOptionId?: string | null;
  /** 本次提交的文本（填空冻结回放用；主动不会为 null） */
  submittedAnswerText?: string | null;
  /** 表达题主动不会揭示：参考句与目标用法说明 */
  referenceAnswer?: string | null;
  answerNote?: string | null;
}

/** 表达题判定文案与克制配色（PRODUCT §7.4/§12；basic_pass 用 warning 语义色） */
export const PRODUCTION_VERDICTS: Record<
  QuestionAnswerResult['result'],
  { label: string; className: string }
> = {
  pass: { label: '通过', className: 'text-success' },
  basic_pass: { label: '基本通过', className: 'text-warning' },
  fail: { label: '未通过', className: 'text-destructive' },
};
