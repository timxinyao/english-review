import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  ChoicePayload,
  ClozePayload,
  CONTENT_LEVELS,
  DEFAULT_CONTENT_LEVEL,
  type CheckClozeResult,
  type GenerateClozeQuestionsResult,
  type GenerateUnderstandingQuestionsResult,
  type ReviewDimension,
} from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import { learningExamples, learningItems, questions, settings } from '../../db/schema.js';
import { appError } from '../../lib/errors.js';
import { completeStructured } from '../../ai/complete.js';
import { getTaskConfig } from '../../ai/taskConfig.js';
import type { AiRuntime } from '../../ai/runtime.js';

/** drizzle 事务回调的 tx 参数类型（与 AppDatabase 同源的 BaseSQLiteDatabase） */
export type DbTx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/** 可在事务内外通用的执行器：db 实例或事务 tx */
export type DbExecutor = AppDatabase | DbTx;

/** questions 表行类型 */
export type QuestionRow = typeof questions.$inferSelect;

/** 练习池题型（production 题 Phase 4 另行处理） */
export type QuestionPoolType = 'understanding' | 'cloze';

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
 * 取出即置 status='active'、use_count+1、last_used_at=now（同步执行，可在事务内调用）。
 * 无库存返回 null。
 */
export function acquireQuestion(
  db: DbExecutor,
  itemId: string,
  type: QuestionPoolType,
  now: Date,
): QuestionRow | null {
  const candidate = db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.learningItemId, itemId),
        eq(questions.type, type),
        inArray(questions.status, ['fresh', 'active']),
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

  // 变量名与 prompts/generate_understanding.v1.md / generate_cloze.v1.md 一致
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

  if (type === 'understanding') {
    const { data, meta } = await completeStructured<GenerateUnderstandingQuestionsResult>(
      aiDeps,
      'generateUnderstandingQuestions',
      vars,
    );
    const model = getTaskConfig('generateUnderstandingQuestions', runtime.config).model;
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
  } else {
    const { data, meta } = await completeStructured<GenerateClozeQuestionsResult>(
      aiDeps,
      'generateClozeQuestions',
      vars,
    );
    const model = getTaskConfig('generateClozeQuestions', runtime.config).model;
    rows = data.questions.map((q) => {
      // 标准答案置于 acceptedAnswers 首位，作为规范形式（AI_RULES §7：answer ∈ accepted_answers）
      const acceptedAnswers = [q.answer, ...q.accepted_answers.filter((a) => a !== q.answer)];
      return {
        id: randomUUID(),
        learningItemId: itemId,
        type: 'cloze',
        status: 'fresh',
        meaningSnapshot: item.meaning,
        promptText: q.text_with_blank,
        contextText: null,
        payloadJson: JSON.stringify(ClozePayload.parse({ acceptedAnswers })),
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
      };
    });
  }

  // 校验：题目 meaning_snapshot 必须锁定当前义项（AI_RULES §4.2）
  for (const row of rows) {
    if (row.meaningSnapshot !== item.meaning) {
      throw appError('INTERNAL', '生成题目的 meaning_snapshot 与当前义项不一致，拒绝入库');
    }
  }

  db.transaction((tx) => {
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
  if (!runtime || runtime.provider.name !== 'glm') return null;
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

// ---------- 维度 → 题型映射（PRODUCT §6.3）----------

export function questionTypeForDimension(dimension: ReviewDimension): QuestionPoolType {
  return dimension === 'understanding' ? 'understanding' : 'cloze';
}
