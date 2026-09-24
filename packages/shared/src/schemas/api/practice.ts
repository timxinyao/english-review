import { z } from 'zod';
import { CorrectionView } from './today.js';

// ---------- Library「练一下」（PRODUCT §4.4：不改正式进度，不造补强，不计 Today/热力图）----------

export const PracticeQuestion = z.discriminatedUnion('qtype', [
  z.object({
    qtype: z.literal('choice'),
    questionId: z.string(),
    kind: z.enum(['direct_meaning', 'context_meaning']),
    context: z.string().nullable(),
    question: z.string(),
    options: z.array(z.object({ id: z.string(), text: z.string() })).min(2),
  }),
  z.object({
    qtype: z.literal('cloze'),
    questionId: z.string(),
    textWithBlank: z.string(),
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
  questions: z.array(PracticeQuestion).min(1).max(3),
});
export type PracticeStartResponse = z.infer<typeof PracticeStartResponse>;

export const PracticeAnswerRequest = z.object({
  selectedOptionId: z.string().min(1).optional(),
  answerText: z.string().min(1).max(500).optional(),
});
export type PracticeAnswerRequest = z.infer<typeof PracticeAnswerRequest>;

export const PracticeAnswerResponse = z.object({
  result: z.enum(['pass', 'basic_pass', 'fail']),
  correct: z.boolean(),
  explanation: z.string().nullable(),
  correctOptionId: z.string().nullable(),
  completeSentence: z.string().nullable(),
  acceptedAnswer: z.string().nullable(),
  correction: CorrectionView.nullable(),
  personalExampleSaved: z.boolean(),
});
export type PracticeAnswerResponse = z.infer<typeof PracticeAnswerResponse>;
