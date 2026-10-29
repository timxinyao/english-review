import { z } from 'zod';
import { ChoiceQuestionView, CorrectionView } from './today.js';

// ---------- Library「练一下」（V2 / Phase 9：Recall + 可选 Production；PRODUCT §4.4）----------
// 不改正式进度，不造补强，不计 Today/热力图；word 默认关 / chunk 默认开 production，
// 由 learning_items.production_enabled_override 覆盖（effectiveProductionEnabled）。

export const PracticeQuestion = z.union([
  z.object({
    qtype: z.literal('recall'),
    questionId: z.string(),
    target: z.string(),
    /** Source example for Recall card; null when absent */
    context: z.string().nullable(),
    /** Hint-mode choice face (same as Today Recall); meaning never sent here */
    hint: ChoiceQuestionView,
  }),
  z.object({
    qtype: z.literal('production'),
    questionId: z.string(),
    zhPrompt: z.string(),
    mustUse: z.string(),
  }),
  z.object({
    qtype: z.literal('production'),
    kind: z.literal('scramble'),
    questionId: z.string(),
    zhPrompt: z.string(),
    targets: z
      .array(z.object({ learningItemId: z.string(), surface: z.string() }))
      .min(1)
      .max(3),
    chips: z.array(z.string().min(1)).min(2),
  }),
]);
export type PracticeQuestion = z.infer<typeof PracticeQuestion>;

export const PracticeStartResponse = z.object({
  questions: z.array(PracticeQuestion).min(1).max(2),
});
export type PracticeStartResponse = z.infer<typeof PracticeStartResponse>;

export const PracticeAnswerRequest = z
  .object({
    /** Recall 直判（三档自评：recalled=良好 / easy=简单 / forgot=重来；与 selectedOptionId 二选一） */
    recall: z.enum(['recalled', 'easy', 'forgot']).optional(),
    selectedOptionId: z.string().min(1).optional(),
    /** Hint 模式提交的选择题标识（仅随 selectedOptionId） */
    hintUsed: z.boolean().optional(),
    answerText: z.string().min(1).max(500).optional(),
    selectedTokens: z.array(z.string().min(1)).min(1).max(32).optional(),
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
  itemResults: z
    .array(
      z.object({
        learningItemId: z.string(),
        surface: z.string(),
        result: z.enum(['pass', 'basic_pass', 'fail']),
      }),
    )
    .nullable()
    .optional(),
  referenceTokens: z.array(z.string()).nullable().optional(),
});
export type PracticeAnswerResponse = z.infer<typeof PracticeAnswerResponse>;
