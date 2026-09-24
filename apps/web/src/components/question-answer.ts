import type { CorrectionView } from '@el/shared';

/**
 * Today 作答（AnswerResponse）与 Library 练一下（PracticeAnswerResponse）
 * 共用的结果展示子集——共享题型卡只消费这些字段。
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
}

/** 表达题判定文案与克制配色（PRODUCT §7.4/§12） */
export const PRODUCTION_VERDICTS: Record<
  QuestionAnswerResult['result'],
  { label: string; className: string }
> = {
  pass: { label: '通过', className: 'text-success' },
  basic_pass: { label: '基本通过', className: 'text-muted-foreground' },
  fail: { label: '未通过', className: 'text-destructive' },
};
