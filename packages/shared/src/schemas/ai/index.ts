import { z } from 'zod';

/**
 * 7 个 AI 任务的输出 Schema（AI_RULES.md §5–§12）。
 * Schema 名与 Prompt frontmatter 的 response_schema 字段一一对应，
 * 由 Prompt Registry 校验、completeStructured 执行。
 */

// ---------- generate_understanding ----------

export const UnderstandingOption = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

export const UnderstandingQuestion = z.object({
  kind: z.enum(['direct_meaning', 'context_meaning']),
  context: z.string().min(1),
  question: z.string().min(1),
  options: z.array(UnderstandingOption).length(4),
  correct_option_id: z.string().min(1),
  explanation: z.string().min(1),
});

export const GenerateUnderstandingQuestionsResult = z.object({
  questions: z.array(UnderstandingQuestion).min(1),
});
export type GenerateUnderstandingQuestionsResult = z.infer<
  typeof GenerateUnderstandingQuestionsResult
>;

// ---------- generate_cloze ----------

export const ClozeQuestion = z
  .object({
    text_with_blank: z
      .string()
      .min(1)
      .refine((s) => (s.match(/____/g) ?? []).length === 1, {
        message: 'text_with_blank 必须恰好包含一个 ____',
      }),
    answer: z.string().min(1),
    accepted_answers: z.array(z.string().min(1)).min(1),
    explanation: z.string().min(1),
  })
  .refine((q) => q.accepted_answers.includes(q.answer), {
    message: 'answer 必须包含在 accepted_answers 中',
    path: ['accepted_answers'],
  });
export const GenerateClozeQuestionsResult = z.object({
  questions: z.array(ClozeQuestion).min(1),
});
export type GenerateClozeQuestionsResult = z.infer<typeof GenerateClozeQuestionsResult>;

// ---------- check_cloze ----------

export const CheckClozeResult = z.object({
  accepted: z.boolean(),
  canonical_answer: z.string(),
  reason: z.string(),
});
export type CheckClozeResult = z.infer<typeof CheckClozeResult>;

// ---------- generate_production_prompt ----------

export const GenerateProductionPromptResult = z.object({
  zh_prompt: z.string().min(1),
  must_use: z.string().min(1),
  reference_answer: z.string().min(1),
  acceptance_notes: z.string().min(1),
});
export type GenerateProductionPromptResult = z.infer<typeof GenerateProductionPromptResult>;

// ---------- check_production ----------

export const CorrectionSegment = z.object({
  text: z.string(),
  type: z.enum(['same', 'delete', 'insert']),
});
export type CorrectionSegment = z.infer<typeof CorrectionSegment>;

export const PersonalExampleCandidate = z.object({
  eligible: z.boolean(),
  quality_score: z.number().min(0).max(1),
  reason: z.string(),
});

export const CheckProductionResult = z.object({
  result: z.enum(['pass', 'basic_pass', 'fail']),
  corrected_sentence: z.string(),
  segments: z.array(CorrectionSegment),
  explanation: z.string(),
  better_version: z.string().nullable(),
  personal_example_candidate: PersonalExampleCandidate,
});
export type CheckProductionResult = z.infer<typeof CheckProductionResult>;

/** 从 segments 重建原句（same+delete 依序拼接）与纠错句（same+insert） */
export function reconstructFromSegments(segments: readonly CorrectionSegment[]): {
  original: string;
  corrected: string;
} {
  let original = '';
  let corrected = '';
  for (const seg of segments) {
    if (seg.type === 'same') {
      original += seg.text;
      corrected += seg.text;
    } else if (seg.type === 'delete') {
      original += seg.text;
    } else {
      corrected += seg.text;
    }
  }
  return { original, corrected };
}

// ---------- generate_read ----------

export const ReadCoverageEntry = z.object({
  learning_item_id: z.string().min(1),
  surface_form: z.string().min(1),
});

/**
 * V2（AI_RULES §11）：纯阅读——只含 title/type/body/coverage。
 * strict：模型仍输出 V1 的 `checks` 字段时直接判非法（completeStructured 拒绝并重试）。
 */
export const GenerateReadResult = z
  .object({
    title: z.string().min(1),
    type: z.enum(['story', 'daily_scene', 'knowledge', 'short_opinion']),
    body: z.string().min(1),
    coverage: z.array(ReadCoverageEntry).min(1),
  })
  .strict();
export type GenerateReadResult = z.infer<typeof GenerateReadResult>;

// ---------- judge_duplicate_meaning ----------

export const JudgeDuplicateMeaningResult = z.object({
  decision: z.enum(['merge', 'new_item', 'skip_exact_duplicate']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type JudgeDuplicateMeaningResult = z.infer<typeof JudgeDuplicateMeaningResult>;

// ---------- 任务目录：task ↔ prompt_key ↔ response_schema ----------

export const AI_TASKS = [
  'generateUnderstandingQuestions',
  'generateClozeQuestions',
  'checkCloze',
  'generateProductionPrompt',
  'checkProduction',
  'generateRead',
  'judgeDuplicateMeaning',
] as const;
export type AiTask = (typeof AI_TASKS)[number];

export interface AiTaskSpec {
  task: AiTask;
  promptKey: string;
  responseSchemaName: string;
}

export const AI_TASK_CATALOG: Record<AiTask, AiTaskSpec> = {
  generateUnderstandingQuestions: {
    task: 'generateUnderstandingQuestions',
    promptKey: 'generate_understanding',
    responseSchemaName: 'GenerateUnderstandingQuestionsResult',
  },
  generateClozeQuestions: {
    task: 'generateClozeQuestions',
    promptKey: 'generate_cloze',
    responseSchemaName: 'GenerateClozeQuestionsResult',
  },
  checkCloze: {
    task: 'checkCloze',
    promptKey: 'check_cloze',
    responseSchemaName: 'CheckClozeResult',
  },
  generateProductionPrompt: {
    task: 'generateProductionPrompt',
    promptKey: 'generate_production_prompt',
    responseSchemaName: 'GenerateProductionPromptResult',
  },
  checkProduction: {
    task: 'checkProduction',
    promptKey: 'check_production',
    responseSchemaName: 'CheckProductionResult',
  },
  generateRead: {
    task: 'generateRead',
    promptKey: 'generate_read',
    responseSchemaName: 'GenerateReadResult',
  },
  judgeDuplicateMeaning: {
    task: 'judgeDuplicateMeaning',
    promptKey: 'judge_duplicate_meaning',
    responseSchemaName: 'JudgeDuplicateMeaningResult',
  },
};

/** response_schema 名 → Zod Schema（Registry 校验 frontmatter 时使用） */
export const AI_RESPONSE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  GenerateUnderstandingQuestionsResult,
  GenerateClozeQuestionsResult,
  CheckClozeResult,
  GenerateProductionPromptResult,
  CheckProductionResult,
  GenerateReadResult,
  JudgeDuplicateMeaningResult,
};

/** prompt_key → task（反查） */
export const PROMPT_KEY_TO_TASK: Record<string, AiTask> = Object.fromEntries(
  Object.values(AI_TASK_CATALOG).map((spec) => [spec.promptKey, spec.task]),
) as Record<string, AiTask>;
