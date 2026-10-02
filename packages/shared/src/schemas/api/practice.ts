import { z } from 'zod';
import { ChoiceQuestionView, CorrectionView } from './today.js';

// ---------- Library「练一下」（V2 / Phase 9：Recall + 可选 Production；PRODUCT §4.4）----------
// 不改正式进度，不造补强，不计 Today/热力图；word 默认关 / chunk 默认开 production，
// 由 learning_items.production_enabled_override 覆盖（effectiveProductionEnabled）。

export const PracticeQuestion = z.discriminatedUnion('qtype', [
  z.object({
    qtype: z.literal('recall'),
    questionId: z.string(),
    target: z.string(),
    /** 原句（Recall 卡展示；null=无 source example） */
    context: z.string().nullable(),
    /** Hint 模式降级用的选择题面（Today Recall Card 同款）；释义绝不在此下发 */
    hint: ChoiceQuestionView,
  }),
  z.object({
    qtype: z.literal('production'),
    questionId: z.string(),
    zhPrompt: z.string(),
    mustUse: z.string(),
  }),
]);
export type PracticeQuestion = z.infer<typeof PracticeQuestion>;

export const PracticeStartResponse = z.object({
  questions: z.array(PracticeQuestion).min(1).max(2),
});
export type PracticeStartResponse = z.infer<typeof PracticeStartResponse>;

export const PracticeAnswerRequest = z
  .object({
    /** Recall 直判（主动回忆自评；与 selectedOptionId 二选一） */
    recall: z.enum(['recalled', 'forgot']).optional(),
    selectedOptionId: z.string().min(1).optional(),
    /** Hint 模式提交的选择题标识（仅随 selectedOptionId） */
    hintUsed: z.boolean().optional(),
    answerText: z.string().min(1).max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.recall && v.selectedOptionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['recall'],
        message: 'recall 与 selectedOptionId 互斥（直判 / Hint 二选一）',
      });
    }
  });
export type PracticeAnswerRequest = z.infer<typeof PracticeAnswerRequest>;

export const PracticeAnswerResponse = z.object({
  result: z.enum(['pass', 'basic_pass', 'fail']),
  correct: z.boolean(),
  /** Recall 题作答后揭示的目标释义（start 响应绝不下发；其余题型 null） */
  meaning: z.string().nullable(),
  explanation: z.string().nullable(),
  correctOptionId: z.string().nullable(),
  completeSentence: z.string().nullable(),
  acceptedAnswer: z.string().nullable(),
  correction: CorrectionView.nullable(),
  personalExampleSaved: z.boolean(),
});
export type PracticeAnswerResponse = z.infer<typeof PracticeAnswerResponse>;
