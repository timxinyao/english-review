import { z } from 'zod';

export const QuestionType = z.enum(['understanding', 'cloze', 'production']);
export type QuestionType = z.infer<typeof QuestionType>;

export const QuestionStatus = z.enum(['fresh', 'active', 'retired', 'bad_question']);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

/** 选择题 payload_json 内部结构 */
export const ChoicePayload = z.object({
  options: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).min(2),
});
export type ChoicePayload = z.infer<typeof ChoicePayload>;

/** 填空题 payload_json 内部结构 */
export const ClozePayload = z.object({
  acceptedAnswers: z.array(z.string().min(1)).min(1),
});
export type ClozePayload = z.infer<typeof ClozePayload>;

export const Question = z.object({
  id: z.string().min(1),
  learningItemId: z.string().min(1),
  type: QuestionType,
  status: QuestionStatus,
  meaningSnapshot: z.string().min(1),
  promptText: z.string().nullable(),
  contextText: z.string().nullable(),
  payloadJson: z.string(),
  correctOptionId: z.string().nullable(),
  promptKey: z.string().min(1),
  promptVersion: z.number().int().min(1),
  promptHash: z.string().min(1),
  model: z.string().min(1),
  useCount: z.number().int().min(0),
  correctCount: z.number().int().min(0),
  lastUsedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type Question = z.infer<typeof Question>;

/** Scramble production payload_json (scramble_v1; server-side, includes reference) */
export const ScrambleTarget = z.object({
  learningItemId: z.string().trim().min(1),
  surface: z.string().trim().min(1),
  tokens: z.array(z.string().trim().min(1)).min(1),
});
export type ScrambleTarget = z.infer<typeof ScrambleTarget>;

export const ScramblePayload = z.object({
  schema: z.literal('scramble_v1'),
  targets: z
    .array(ScrambleTarget)
    .min(1)
    .max(3)
    .refine(
      (targets) => new Set(targets.map((target) => target.learningItemId)).size === targets.length,
      'Scramble target ids must be unique',
    ),
  zhPrompt: z.string().trim().min(1),
  referenceTokens: z.array(z.string().trim().min(1)).min(1).max(24),
  distractors: z.array(z.string().trim().min(1)),
  acceptableMorphology: z.array(z.string().trim().min(1)).default([]),
  acceptanceNotes: z.string().default(''),
});
export type ScramblePayload = z.infer<typeof ScramblePayload>;
