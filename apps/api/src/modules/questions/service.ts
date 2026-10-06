import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  ChoicePayload,
  ClozePayload,
  CONTENT_LEVELS,
  DEFAULT_CONTENT_LEVEL,
  type BetterVersionKind,
  type CheckClozeResult,
  type CheckProductionResult,
  type CorrectionSegment,
  type GenerateProductionPromptResult,
  type GenerateUnderstandingQuestionsResult,
  type ReviewDimension,
} from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import { learningExamples, learningItems, questions, settings } from '../../db/schema.js';
import { appError } from '../../lib/errors.js';
import { completeStructured } from '../../ai/complete.js';
import type { AiRuntime } from '../../ai/runtime.js';

/** drizzle 事务回调的 tx 参数类型（与 AppDatabase 同源的 BaseSQLiteDatabase） */
export type DbTx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/** 可在事务内外通用的执行器：db 实例或事务 tx */
export type DbExecutor = AppDatabase | DbTx;

/** questions 表行类型 */
export type QuestionRow = typeof questions.$inferSelect;

/** 练习池题型（含 Phase 4 表达题） */
export type QuestionPoolType = 'understanding' | 'cloze' | 'production';

/** AI runtime（getAiRuntime() 的返回类型 AiRuntime | null；测试可注入 mock） */
export type QuestionRuntime = AiRuntime | null;

/**
 * 题目缓存失效（PRODUCT_DESIGN §6.6 / AGENTS.md §5）：
 * target 或 meaning 变化时，将该 Item 所有 fresh/active 题置为 retired（retired_at=now）。
 * 必须在 learning-items 编辑事务内（同步回调）调用；返回失效条数。
 */
export function invalidateQuestions(
  tx: DbExecutor,
  learningItemId: string,
  nowIso: string,
): number {
  return tx
    .update(questions)
    .set({ status: 'retired', retiredAt: nowIso })
    .where(
      and(
        eq(questions.learningItemId, learningItemId),
        inArray(questions.status, ['fresh', 'active']),
      ),
    )
    .run().changes;
}

// ---------- 题库存量 ----------

/** fresh + active 状态的题数（可进入练习池的库存） */
export function countQuestionStock(db: DbExecutor, itemId: string, type: QuestionPoolType): number {
  const row = db
    .select({ total: sql<number>`count(*)` })
    .from(questions)
    .where(
      and(
        eq(questions.learningItemId, itemId),
        eq(questions.type, type),
        inArray(questions.status, ['fresh', 'active']),
      ),
    )
    .get();
  return row ? Number(row.total) : 0;
}

// ---------- 取题 ----------

/**
 * 从练习池取一题：fresh/active 中按 last_used_at 最旧优先（null 最先，从未用过的先出）。
 * excludeQuestionIds：跳过指定题目（Today 撤销替代题必须与原题不同，TECHNICAL_DESIGN §7.5）。
 * 取出即置 status='active'、use_count+1、last_used_at=now（同步执行，可在事务内调用）。
 * 无库存返回 null。
 */
export function acquireQuestion(
  db: DbExecutor,
  itemId: string,
  type: QuestionPoolType,
  now: Date,
  excludeQuestionIds?: string[],
): QuestionRow | null {
  if (type === 'cloze') throw appError('CONFLICT', 'V2 不再分配填空题');
  const excluded = excludeQuestionIds ?? [];
  const candidate = db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.learningItemId, itemId),
        eq(questions.type, type),
        inArray(questions.status, ['fresh', 'active']),
        excluded.length > 0 ? notInArray(questions.id, excluded) : undefined,
      ),
    )
    // SQLite：IS NULL DESC 让 NULL 排最前（从未使用优先），其次按时间升序
    .orderBy(sql`${questions.lastUsedAt} IS NULL DESC`, questions.lastUsedAt)
    .get();
  if (!candidate) return null;

  const nowIso = now.toISOString();
  db.update(questions)
    .set({ status: 'active', useCount: candidate.useCount + 1, lastUsedAt: nowIso })
    .where(eq(questions.id, candidate.id))
    .run();

  return { ...candidate, status: 'active', useCount: candidate.useCount + 1, lastUsedAt: nowIso };
}

// ---------- AI 生成 ----------

export interface GenerateQuestionsDeps {
  db: AppDatabase;
  runtime: QuestionRuntime;
}

/** settings 表的 content_level（缺省 B1；非法值回退默认） */
function readContentLevel(db: AppDatabase): string {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  const level = row?.contentLevel;
  return level && (CONTENT_LEVELS as readonly string[]).includes(level)
    ? level
    : DEFAULT_CONTENT_LEVEL;
}

/** 该 item 该 type 最近 limit 题的一句话摘要（供 Prompt 避免重复出题；可为 []） */
function recentQuestionSummaries(
  db: AppDatabase,
  itemId: string,
  type: QuestionPoolType,
  limit: number,
): string[] {
  const rows = db
    .select({ contextText: questions.contextText, promptText: questions.promptText })
    .from(questions)
    .where(and(eq(questions.learningItemId, itemId), eq(questions.type, type)))
    .orderBy(desc(questions.createdAt), desc(questions.id))
    .limit(limit)
    .all();
  return rows
    .reverse()
    .map((r) => [r.contextText, r.promptText].filter((t): t is string => Boolean(t)).join(' | '));
}

/** 该 item 最近 limit 道表达题的中文题干（generate_production_prompt 的 recent_prompts 变量） */
function recentProductionPrompts(db: AppDatabase, itemId: string, limit: number): string[] {
  const rows = db
    .select({ promptText: questions.promptText })
    .from(questions)
    .where(and(eq(questions.learningItemId, itemId), eq(questions.type, 'production')))
    .orderBy(desc(questions.createdAt), desc(questions.id))
    .limit(limit)
    .all();
  return rows
    .reverse()
    .map((r) => r.promptText)
    .filter((t): t is string => Boolean(t));
}

/**
 * 为 item 生成 count 道题并入库（AI_RULES §6/§7）：
 * 读 item+例句 → 组装变量（content_level 取 settings）→ completeStructured（Schema + 不变式 + 重试）
 * → 逐题入库（meaning_snapshot 锁定当前义项、prompt_key/version/hash、model、payload_json、correct_option_id）
 * → 返回插入行。AI 调用在事务外完成，落库为同步事务；失败抛错不入库。
 * runtime.provider 可为 mock（测试注入）；生产无 key 时 completeStructured 会失败，由调用方处理。
 */
export async function generateQuestionsForItem(
  deps: GenerateQuestionsDeps,
  itemId: string,
  type: QuestionPoolType,
  count: number,
): Promise<QuestionRow[]> {
  if (type === 'cloze') throw appError('CONFLICT', 'V2 不再生成填空题');
  const { db, runtime } = deps;
  if (!runtime) throw appError('AI_PROVIDER_ERROR', 'AI runtime 未初始化，无法生成题目');
  if (!Number.isInteger(count) || count <= 0) return [];

  const item = db.select().from(learningItems).where(eq(learningItems.id, itemId)).get();
  if (!item) throw appError('NOT_FOUND', '学习项不存在');

  const examples = db
    .select()
    .from(learningExamples)
    .where(eq(learningExamples.learningItemId, itemId))
    .all();
  const sourceExample = examples.find((e) => e.kind === 'source');
  if (!sourceExample) throw appError('INTERNAL', '学习项缺少 source 例句，无法生成题目');
  const extraExamples = examples
    .filter((e) => e.kind === 'extra')
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((e) => e.text);

  // 变量名与 prompts/generate_understanding.v1.md 一致
  const vars = {
    type: item.type,
    target: item.target,
    meaning: item.meaning,
    content_level: readContentLevel(db),
    source_example: sourceExample.text,
    extra_examples: extraExamples,
    count,
    recent_question_summaries: recentQuestionSummaries(db, itemId, type, 5),
  };

  const aiDeps = {
    provider: runtime.provider,
    config: runtime.config,
    registry: runtime.registry,
  };
  const nowIso = new Date().toISOString();
  let rows: QuestionRow[];

  if (type === 'production') {
    // generate_production_prompt 为单题结构（AI_RULES §9）：count 道题 = count 次调用，
    // 每次把本批已生成的 zh_prompt 并入 recent_prompts 避免重复
    rows = [];
    let model = '';
    const recentPrompts = recentProductionPrompts(db, itemId, 5);
    for (let i = 0; i < count; i += 1) {
      const {
        data,
        meta,
        model: usedModel,
      } = await completeStructured<GenerateProductionPromptResult>(
        aiDeps,
        'generateProductionPrompt',
        {
          type: item.type,
          target: item.target,
          meaning: item.meaning,
          content_level: readContentLevel(db),
          source_example: sourceExample.text,
          extra_examples: extraExamples,
          recent_prompts: recentPrompts,
        },
      );
      recentPrompts.push(data.zh_prompt);
      if (!model) model = usedModel;
      rows.push({
        id: randomUUID(),
        learningItemId: itemId,
        type: 'production',
        status: 'fresh',
        meaningSnapshot: item.meaning,
        promptText: data.zh_prompt,
        contextText: null,
        payloadJson: JSON.stringify({
          mustUse: data.must_use,
          referenceAnswer: data.reference_answer,
          acceptanceNotes: data.acceptance_notes,
        }),
        correctOptionId: null,
        promptKey: meta.key,
        promptVersion: meta.version,
        promptHash: meta.hash,
        model,
        useCount: 0,
        correctCount: 0,
        lastUsedAt: null,
        retiredAt: null,
        createdAt: nowIso,
      });
    }
  } else {
    const { data, meta, model } = await completeStructured<GenerateUnderstandingQuestionsResult>(
      aiDeps,
      'generateUnderstandingQuestions',
      vars,
    );
    rows = data.questions.map((q) => ({
      id: randomUUID(),
      learningItemId: itemId,
      type: 'understanding',
      status: 'fresh',
      meaningSnapshot: item.meaning,
      promptText: q.question,
      contextText: q.context,
      payloadJson: JSON.stringify(ChoicePayload.parse({ options: q.options })),
      correctOptionId: q.correct_option_id,
      promptKey: meta.key,
      promptVersion: meta.version,
      promptHash: meta.hash,
      model,
      useCount: 0,
      correctCount: 0,
      lastUsedAt: null,
      retiredAt: null,
      createdAt: nowIso,
    }));
  }

  // 校验：题目 meaning_snapshot 必须锁定当前义项（AI_RULES §4.2）
  for (const row of rows) {
    if (row.meaningSnapshot !== item.meaning) {
      throw appError('INTERNAL', '生成题目的 meaning_snapshot 与当前义项不一致，拒绝入库');
    }
  }

  db.transaction((tx) => {
    const current = tx.select().from(learningItems).where(eq(learningItems.id, itemId)).get();
    if (!current || current.target !== item.target || current.meaning !== item.meaning) {
      throw appError('CONFLICT', '学习项已修改，旧题目生成结果已失效');
    }
    for (const row of rows) {
      tx.insert(questions).values(row).run();
    }
  });
  return rows;
}

// ---------- 判定 ----------

/** 选择题判定：提交的是 shuffle 后的 option id（PRODUCT §7.1） */
export function evaluateChoice(
  question: QuestionRow,
  selectedOptionId: string,
): { correct: boolean; correctOptionId: string } {
  if (!question.correctOptionId) {
    throw appError('INTERNAL', `题目 ${question.id} 不是选择题，缺少 correct_option_id`);
  }
  return {
    correct: question.correctOptionId === selectedOptionId,
    correctOptionId: question.correctOptionId,
  };
}

/**
 * 填空答案归一化：小写、压缩空白（保留单词间单空格）、去首尾标点（AI_RULES §8）。
 * 用于本地确定性判定。
 */
export function normalizeClozeAnswer(answer: string): string {
  return answer
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '');
}

function parseClozePayload(question: QuestionRow): ClozePayload {
  if (question.type !== 'cloze' || !question.promptText) {
    throw appError('INTERNAL', `题目 ${question.id} 不是合法的填空题`);
  }
  const parsed = ClozePayload.safeParse(JSON.parse(question.payloadJson));
  if (!parsed.success) {
    throw appError('INTERNAL', `题目 ${question.id} 的 payload 不是合法的填空题数据`);
  }
  return parsed.data;
}

export interface ClozeEvaluation {
  correct: boolean;
  canonicalAnswer: string;
  usedAi: boolean;
}

/** 可注入的 AI 兜底判定（测试用）；生产默认实现仅当 runtime 为 glm 时调用 checkCloze */
export type ClozeAiCheck = (question: QuestionRow, userAnswer: string) => Promise<CheckClozeResult>;

export interface EvaluateClozeDeps {
  db: DbExecutor;
  runtime: QuestionRuntime;
  /** 注入则完全替代默认 AI 兜底路径 */
  aiCheck?: ClozeAiCheck;
}

/** 默认 AI 兜底：runtime 为 glm（有 key）时走 checkCloze；mock/未初始化返回 null（不走 AI） */
function createDefaultClozeAiCheck(deps: EvaluateClozeDeps): ClozeAiCheck | null {
  const { db, runtime } = deps;
  if (!runtime || runtime.provider.name === 'mock') return null; // 生产守卫：mock 不得入题库（routed/glm 均为真实 AI）
  return async (question, userAnswer) => {
    const item = db
      .select()
      .from(learningItems)
      .where(eq(learningItems.id, question.learningItemId))
      .get();
    if (!item) throw appError('NOT_FOUND', '学习项不存在');
    const payload = parseClozePayload(question);
    const { data } = await completeStructured<CheckClozeResult>(
      { provider: runtime.provider, config: runtime.config, registry: runtime.registry },
      'checkCloze',
      {
        type: item.type,
        target: item.target,
        meaning: question.meaningSnapshot,
        text_with_blank: question.promptText,
        answer: payload.acceptedAnswers[0]!,
        accepted_answers: payload.acceptedAnswers,
        user_answer: userAnswer,
      },
    );
    return data;
  };
}

/**
 * 填空题判定（AI_RULES §8）：
 * 本地：normalize（小写/压缩空白/去首尾标点）后与 accepted_answers 全等 → correct。
 * 本地不等且 AI 可用（glm 或注入 aiCheck）→ checkCloze 兜底；AI 失败按拒绝处理，不产生脏判定。
 */
export async function evaluateCloze(
  deps: EvaluateClozeDeps,
  question: QuestionRow,
  userAnswer: string,
): Promise<ClozeEvaluation> {
  const payload = parseClozePayload(question);
  const canonical = payload.acceptedAnswers[0]!;

  const userNorm = normalizeClozeAnswer(userAnswer);
  const localMatch = payload.acceptedAnswers.find((a) => normalizeClozeAnswer(a) === userNorm);
  if (localMatch !== undefined) {
    return { correct: true, canonicalAnswer: localMatch, usedAi: false };
  }

  const aiCheck = deps.aiCheck ?? createDefaultClozeAiCheck(deps);
  if (!aiCheck) {
    return { correct: false, canonicalAnswer: canonical, usedAi: false };
  }
  try {
    const result = await aiCheck(question, userAnswer);
    return {
      correct: result.accepted,
      canonicalAnswer: result.canonical_answer || canonical,
      usedAi: true,
    };
  } catch {
    return { correct: false, canonicalAnswer: canonical, usedAi: true };
  }
}

// ---------- 表达题批改（check_production，AI_RULES §10）----------

/** 表达题 payload_json 内部结构（mustUse / referenceAnswer / acceptanceNotes） */
export interface ProductionQuestionPayload {
  mustUse: string;
  referenceAnswer: string;
  acceptanceNotes: string;
}

function parseProductionPayload(question: QuestionRow): ProductionQuestionPayload {
  if (question.type !== 'production' || !question.promptText) {
    throw appError('INTERNAL', `题目 ${question.id} 不是合法的表达题`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(question.payloadJson);
  } catch {
    throw appError('INTERNAL', `题目 ${question.id} 的 payload 不是合法 JSON`);
  }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  if (
    typeof obj.mustUse !== 'string' ||
    !obj.mustUse ||
    typeof obj.referenceAnswer !== 'string' ||
    !obj.referenceAnswer ||
    typeof obj.acceptanceNotes !== 'string' ||
    !obj.acceptanceNotes
  ) {
    throw appError('INTERNAL', `题目 ${question.id} 的 payload 不是合法的表达题数据`);
  }
  return {
    mustUse: obj.mustUse,
    referenceAnswer: obj.referenceAnswer,
    acceptanceNotes: obj.acceptanceNotes,
  };
}

/** 批改实际使用的 Prompt 元数据（写入 attempt 的 ai_prompt_* 追溯字段） */
export interface ProductionPromptMeta {
  key: string;
  version: number;
  hash: string;
  model: string;
}

/** personal_example_candidate 投影（AI_RULES §10：eligible/quality_score，替换由后端决定） */
export interface ProductionCandidate {
  eligible: boolean;
  source: 'corrected' | 'better' | null;
  qualityScore: number;
  reason: string;
}

/** evaluateProduction 的返回（today / practice 共用） */
export interface ProductionEvaluation {
  result: 'pass' | 'basic_pass' | 'fail';
  correctedSentence: string;
  segments: CorrectionSegment[];
  explanation: string;
  betterVersion: string | null;
  betterVersionKind: BetterVersionKind | null;
  candidate: ProductionCandidate;
  promptMeta: ProductionPromptMeta;
}

export interface EvaluateProductionDeps {
  db: AppDatabase;
  runtime: QuestionRuntime;
}

/**
 * 表达题实时批改（事务外调用）：读题目 payload 与 item 例句 → 组装 check_production
 * 变量 → completeStructured（Schema + segments 重建不变式 + 重试）。失败抛
 * AiStructuredError，由调用方决定降级；不产生任何脏数据。
 */
export async function evaluateProduction(
  deps: EvaluateProductionDeps,
  question: QuestionRow,
  userAnswer: string,
): Promise<ProductionEvaluation> {
  const { db, runtime } = deps;
  if (!runtime) throw appError('AI_PROVIDER_ERROR', 'AI runtime 未初始化，无法批改');

  const payload = parseProductionPayload(question);
  const item = db
    .select()
    .from(learningItems)
    .where(eq(learningItems.id, question.learningItemId))
    .get();
  if (!item) throw appError('NOT_FOUND', '学习项不存在');

  const examples = db
    .select()
    .from(learningExamples)
    .where(eq(learningExamples.learningItemId, item.id))
    .all();
  const sourceExample = examples.find((e) => e.kind === 'source');
  if (!sourceExample) throw appError('INTERNAL', '学习项缺少 source 例句，无法批改');
  const extraExamples = examples
    .filter((e) => e.kind === 'extra')
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((e) => e.text);

  // 变量名与 prompts/check_production.v2.md 一致；locked_meaning 用题目生成时锁定的
  // meaning_snapshot（与 check_cloze 兜底一致；正常流下等于 item.meaning）
  const { data, meta, model } = await completeStructured<CheckProductionResult>(
    { provider: runtime.provider, config: runtime.config, registry: runtime.registry },
    'checkProduction',
    {
      type: item.type,
      target: item.target,
      meaning: question.meaningSnapshot,
      zh_prompt: question.promptText,
      reference_answer: payload.referenceAnswer,
      acceptance_notes: payload.acceptanceNotes,
      source_example: sourceExample.text,
      extra_examples: extraExamples,
      user_answer: userAnswer,
    },
  );
  return {
    result: data.result,
    correctedSentence: data.corrected_sentence,
    segments: data.segments,
    explanation: data.explanation,
    betterVersion: data.better_version,
    betterVersionKind: data.better_version_kind,
    candidate: {
      eligible: data.personal_example_candidate.eligible,
      source: data.personal_example_candidate.source,
      qualityScore: data.personal_example_candidate.quality_score,
      reason: data.personal_example_candidate.reason,
    },
    promptMeta: { key: meta.key, version: meta.version, hash: meta.hash, model },
  };
}

// ---------- V2 维度 → 题型映射 ----------

export function questionTypeForDimension(dimension: ReviewDimension): QuestionPoolType {
  return dimension === 'understanding' ? 'understanding' : 'production';
}

/** 保持 Today 旧调用签名；V2 所有 P 等级都只取完整造句题。 */
export function productionQuestionTypeFor(_itemId: string, _level: number): 'production' {
  return 'production';
}

/**
 * 到期维度需要预取的题型。V2 Recall 化后 understanding 的复习/新学/补强全都不消费
 * 绑定题（三档自评，卡面来自 item；练一下走懒生成），2026-10-06 起到期备货仅
 * production——原先给每词备的 3 道 understanding 题从未被 UI 展示，纯 token 浪费。
 */
export function questionTypesForDue(dimension: ReviewDimension): [] | ['production'] {
  return dimension === 'production' ? ['production'] : [];
}
