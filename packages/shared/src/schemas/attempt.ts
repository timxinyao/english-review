import { z } from 'zod';
import { AnswerFeedback, AnswerResult } from './review.js';

export const AttemptMode = z.enum(['today', 'library_practice', 'read_check']);
export type AttemptMode = z.infer<typeof AttemptMode>;

export const Attempt = z.object({
  id: z.string().min(1),
  reviewTaskId: z.string().nullable(),
  learningItemId: z.string().min(1),
  questionId: z.string().nullable(),
  mode: AttemptMode,
  answerText: z.string().nullable(),
  selectedOptionId: z.string().nullable(),
  result: AnswerResult,
  viewedSource: z.number().int().min(0).max(1),
  feedback: AnswerFeedback.nullable(),
  correctionJson: z.string().nullable(),
  explanation: z.string().nullable(),
  betterVersion: z.string().nullable(),
  aiPromptKey: z.string().nullable(),
  aiPromptVersion: z.number().int().nullable(),
  aiPromptHash: z.string().nullable(),
  aiModel: z.string().nullable(),
  preStateJson: z.string().nullable(),
  postStateJson: z.string().nullable(),
  createdAt: z.string().min(1),
  voidedAt: z.string().nullable(),
});
export type Attempt = z.infer<typeof Attempt>;
