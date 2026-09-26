import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type {
  PracticeAnswerRequest,
  PracticeAnswerResponse,
  PracticeQuestion,
  PracticeStartResponse,
} from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import { JobLockTimeoutError, withJobLock } from '../../db/job-lock.js';
import { attempts, learningItems, questions, reviewStates } from '../../db/schema.js';
import { AppError, appError } from '../../lib/errors.js';
import type {
  DbExecutor,
  ProductionEvaluation,
  QuestionPoolType,
  QuestionRow,
} from '../questions/service.js';
import { productionQuestionTypeFor } from '../questions/service.js';
import { maybeSavePersonalExample, trimProductionHistory } from '../learning-items/service.js';

// ---------------------------------------------------------------------------
// 依赖接口（questions 模块适配层；默认绑定真实模块，测试可注入 fake —— 同 today 模式）
// ---------------------------------------------------------------------------

export interface PracticeDeps {
  acquire(
    exec: DbExecutor,
    itemId: string,
    type: QuestionPoolType,
    now: Date,
    excludeQuestionIds?: string[],
  ): QuestionRow | null;
  generate(db: AppDatabase, itemId: string, type: QuestionPoolType): Promise<unknown>;
  evaluateChoice(question: QuestionRow, selectedOptionId: string): { correct: boolean };
  evaluateCloze(
    db: AppDatabase,
    question: QuestionRow,
    answerText: string,
  ): Promise<{ correct: boolean }>;
  evaluateProduction(
    db: AppDatabase,
    question: QuestionRow,
    answerText: string,
  ): Promise<ProductionEvaluation>;
}

const QUESTIONS_SERVICE_PATH = '../questions/service.js';

type UnknownModule = Record<string, unknown>;

function requireFn(mod: UnknownModule, name: string): (...args: unknown[]) => unknown {
  const f = mod[name];
  if (typeof f !== 'function') {
    throw new Error(`依赖模块缺少导出函数：${name}`);
  }
  return f as (...args: unknown[]) => unknown;
}

/** 绑定真实 questions 模块 + AI runtime（适配点：若签名有偏差，只改这里） */
export async function loadRealPracticeDeps(): Promise<PracticeDeps> {
  const questionsMod = (await import(QUESTIONS_SERVICE_PATH)) as UnknownModule;
  const runtimeMod = (await import('../../ai/runtime.js')) as UnknownModule;
  const getAiRuntime = runtimeMod.getAiRuntime as () => unknown;

  const acquireFn = requireFn(questionsMod, 'acquireQuestion');
  const generateFn = requireFn(questionsMod, 'generateQuestionsForItem');
  const evaluateChoiceFn = requireFn(questionsMod, 'evaluateChoice');
  const evaluateClozeFn = requireFn(questionsMod, 'evaluateCloze');
  const evaluateProductionFn = requireFn(questionsMod, 'evaluateProduction');

  return {
    acquire: (exec, itemId, type, now, excludeQuestionIds) =>
      (acquireFn(exec, itemId, type, now, excludeQuestionIds) as QuestionRow | null | undefined) ??
      null,
    generate: (db, itemId, type) =>
      Promise.resolve(generateFn({ db, runtime: getAiRuntime() }, itemId, type, 1) as unknown),
    evaluateChoice: (question, selectedOptionId) => {
      const r = evaluateChoiceFn(question, selectedOptionId) as { correct: unknown };
      return { correct: r.correct === true };
    },
    evaluateCloze: async (db, question, answerText) => {
      const r = (await evaluateClozeFn({ db, runtime: getAiRuntime() }, question, answerText)) as {
        correct: unknown;
      };
      return { correct: r.correct === true };
    },
    evaluateProduction: async (db, question, answerText) =>
      (await evaluateProductionFn(
        { db, runtime: getAiRuntime() },
        question,
        answerText,
      )) as ProductionEvaluation,
  };
}

let cachedRealDeps: PracticeDeps | null = null;
let depsOverride: PracticeDeps | null = null;

export async function resolvePracticeDeps(): Promise<PracticeDeps> {
  if (depsOverride) return depsOverride;
  cachedRealDeps ??= await loadRealPracticeDeps();
  return cachedRealDeps;
}

/** 测试专用依赖注入（生产不调用） */
export function setPracticeDepsForTests(deps: PracticeDeps | null): void {
  depsOverride = deps;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function requireItem(db: AppDatabase, itemId: string) {
  const item = db.select().from(learningItems).where(eq(learningItems.id, itemId)).get();
  if (!item) throw appError('NOT_FOUND', '学习项不存在');
  return item;
}

function safePayload(question: QuestionRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(question.payloadJson) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function choiceOptions(payload: Record<string, unknown>): Array<{ id: string; text: string }> {
  if (!Array.isArray(payload.options)) return [];
  return payload.options.filter(
    (o): o is { id: string; text: string } =>
      !!o &&
      typeof o === 'object' &&
      typeof (o as { id: unknown }).id === 'string' &&
      typeof (o as { text: unknown }).text === 'string',
  );
}

/** questions 行 → PracticeQuestion 视图（不泄漏 correctOptionId / referenceAnswer） */
function toPracticeQuestion(question: QuestionRow, target: string): PracticeQuestion {
  const payload = safePayload(question);
  if (question.type === 'understanding') {
    const options = choiceOptions(payload);
    return {
      qtype: 'choice',
      questionId: question.id,
      kind: question.contextText ? 'context_meaning' : 'direct_meaning',
      context: question.contextText ?? null,
      question: question.promptText ?? `${target} 最接近什么意思？`,
      options:
        options.length >= 2
          ? options
          : [
              { id: 'o1', text: '—' },
              { id: 'o2', text: '——' },
            ],
    };
  }
  if (question.type === 'cloze') {
    return {
      qtype: 'cloze',
      questionId: question.id,
      textWithBlank: question.promptText ?? question.contextText ?? '',
    };
  }
  return {
    qtype: 'production',
    questionId: question.id,
    zhPrompt: question.promptText ?? '',
    mustUse: typeof payload.mustUse === 'string' && payload.mustUse ? payload.mustUse : target,
  };
}

/** 事务外取题：无库存时懒生成（AI 失败返回 null，不抛出） */
async function acquireWithGenerate(
  db: AppDatabase,
  deps: PracticeDeps,
  itemId: string,
  type: QuestionPoolType,
  now: Date,
  excludeQuestionIds?: string[],
): Promise<QuestionRow | null> {
  const direct = deps.acquire(db, itemId, type, now, excludeQuestionIds);
  if (direct) return direct;
  try {
    await deps.generate(db, itemId, type);
  } catch (err) {
    console.warn(
      `[practice] 题目生成失败（item=${itemId} type=${type}）：${(err as Error).message}`,
    );
    return null;
  }
  return deps.acquire(db, itemId, type, now, excludeQuestionIds);
}

// ---------------------------------------------------------------------------
// POST /api/library/:id/practice（PRODUCT §4.4）
// ---------------------------------------------------------------------------

/**
 * 临时生成约 3 道与当前阶段匹配的题（不建 session/task、不改正式进度）：
 * - 有 P 状态：1 道理解选择题 + 2 道 P 阶段题（productionQuestionTypeFor：L1/2 填空、L3 哈希、L4+ 表达）
 * - 无 P 状态：2 道选择题 + 1 道填空题
 * 优先从库存取（acquireQuestion），不足且 AI 可用则补生成。
 */
export async function startLibraryPractice(
  db: AppDatabase,
  deps: PracticeDeps,
  itemId: string,
  now: Date,
): Promise<PracticeStartResponse> {
  const item = requireItem(db, itemId);

  const pState = db
    .select()
    .from(reviewStates)
    .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, 'production')))
    .get();

  const wanted: QuestionPoolType[] =
    pState && pState.level > 0
      ? [
          'understanding',
          productionQuestionTypeFor(itemId, pState.level),
          productionQuestionTypeFor(itemId, pState.level),
        ]
      : ['understanding', 'understanding', 'cloze'];

  const usedQuestionIds: string[] = [];
  const out: PracticeQuestion[] = [];
  // 持 question-generation 全局锁（与 today/start、daily-prefetch 互斥，避免并发重复生成）
  try {
    await withJobLock(db, 'question-generation', async () => {
      for (const type of wanted) {
        const q = await acquireWithGenerate(db, deps, itemId, type, now, usedQuestionIds);
        if (!q) continue; // 单类失败不阻断其余题型
        usedQuestionIds.push(q.id);
        out.push(toPracticeQuestion(q, item.target));
      }
    });
  } catch (err) {
    if (err instanceof JobLockTimeoutError) {
      throw appError('CONFLICT', '题目正在准备中，请稍候重试');
    }
    throw err;
  }
  if (out.length === 0) {
    throw appError('AI_PROVIDER_ERROR', '暂时无法生成练习题，请稍后重试');
  }
  return { questions: out };
}

// ---------------------------------------------------------------------------
// POST /api/library/:id/practice/:questionId/answer
// ---------------------------------------------------------------------------

/** 填空题揭示：完整句子 + 可接受答案（与 today 模块一致，替换首个 ____） */
function clozeReveal(question: QuestionRow): {
  completeSentence: string;
  acceptedAnswer: string | null;
} {
  const payload = safePayload(question);
  const accepted = Array.isArray(payload.acceptedAnswers)
    ? payload.acceptedAnswers.filter((a): a is string => typeof a === 'string')
    : [];
  const canonical = accepted[0] ?? null;
  const textWithBlank = question.promptText ?? question.contextText ?? '';
  const completeSentence =
    canonical !== null ? textWithBlank.replace(/_{2,}/, canonical) : textWithBlank;
  return { completeSentence, acceptedAnswer: canonical };
}

/**
 * 练习作答（PRODUCT §4.4）：不改 review_states / next_review_at / status、
 * 不造补强、不写 daily_stats；写 attempt（mode='library_practice'，review_task_id=null）。
 * 表达题优质句仍可入 Personal Example；造句历史参与裁剪。
 */
export async function answerLibraryPractice(
  db: AppDatabase,
  deps: PracticeDeps,
  itemId: string,
  questionId: string,
  body: PracticeAnswerRequest,
  now: Date,
): Promise<PracticeAnswerResponse> {
  requireItem(db, itemId);
  const question = db.select().from(questions).where(eq(questions.id, questionId)).get();
  if (!question || question.learningItemId !== itemId) {
    throw appError('NOT_FOUND', '题目不存在');
  }
  if (question.status !== 'fresh' && question.status !== 'active') {
    throw appError('CONFLICT', '该题目已失效，无法作答');
  }

  const nowIso = now.toISOString();

  if (question.type === 'understanding') {
    if (!body.selectedOptionId) {
      throw appError('VALIDATION_ERROR', '选择题必须提交 selectedOptionId');
    }
    const outcome = deps.evaluateChoice(question, body.selectedOptionId);
    const correct = outcome.correct === true;
    const result: PracticeAnswerResponse['result'] = correct ? 'pass' : 'fail';
    const explanation = correct
      ? null
      : typeof safePayload(question).explanation === 'string'
        ? (safePayload(question).explanation as string)
        : null;
    db.transaction((tx) => {
      tx.insert(attempts)
        .values({
          id: randomUUID(),
          reviewTaskId: null,
          learningItemId: itemId,
          questionId: question.id,
          mode: 'library_practice',
          answerText: null,
          selectedOptionId: body.selectedOptionId ?? null,
          result,
          viewedSource: 0,
          feedback: null,
          correctionJson: null,
          explanation,
          betterVersion: null,
          aiPromptKey: null,
          aiPromptVersion: null,
          aiPromptHash: null,
          aiModel: null,
          preStateJson: null,
          postStateJson: null,
          createdAt: nowIso,
          voidedAt: null,
        })
        .run();
    });
    return {
      result,
      correct,
      explanation,
      correctOptionId: question.correctOptionId,
      completeSentence: null,
      acceptedAnswer: null,
      correction: null,
      personalExampleSaved: false,
    };
  }

  if (question.type === 'cloze') {
    if (!body.answerText) {
      throw appError('VALIDATION_ERROR', '填空题必须提交 answerText');
    }
    const outcome = await deps.evaluateCloze(db, question, body.answerText);
    const correct = outcome.correct === true;
    const result: PracticeAnswerResponse['result'] = correct ? 'pass' : 'fail';
    const explanation = correct
      ? null
      : typeof safePayload(question).explanation === 'string'
        ? (safePayload(question).explanation as string)
        : null;
    const reveal = clozeReveal(question);
    db.transaction((tx) => {
      tx.insert(attempts)
        .values({
          id: randomUUID(),
          reviewTaskId: null,
          learningItemId: itemId,
          questionId: question.id,
          mode: 'library_practice',
          answerText: body.answerText ?? null,
          selectedOptionId: null,
          result,
          viewedSource: 0,
          feedback: null,
          correctionJson: null,
          explanation,
          betterVersion: null,
          aiPromptKey: null,
          aiPromptVersion: null,
          aiPromptHash: null,
          aiModel: null,
          preStateJson: null,
          postStateJson: null,
          createdAt: nowIso,
          voidedAt: null,
        })
        .run();
    });
    return {
      result,
      correct,
      explanation,
      correctOptionId: null,
      completeSentence: reveal.completeSentence,
      acceptedAnswer: reveal.acceptedAnswer,
      correction: null,
      personalExampleSaved: false,
    };
  }

  // ---- 表达题：实时批改 + Personal Example 沉淀（事务外批改失败零写入） ----
  if (!body.answerText) {
    throw appError('VALIDATION_ERROR', '表达题必须提交 answerText');
  }
  let evaluation: ProductionEvaluation;
  try {
    evaluation = await deps.evaluateProduction(db, question, body.answerText);
  } catch (err) {
    if (err instanceof AppError && err.code !== 'AI_PROVIDER_ERROR') throw err;
    throw appError('AI_PROVIDER_ERROR', '批改失败，请重试');
  }

  const personalSaved = db.transaction((tx) => {
    tx.insert(attempts)
      .values({
        id: randomUUID(),
        reviewTaskId: null,
        learningItemId: itemId,
        questionId: question.id,
        mode: 'library_practice',
        answerText: body.answerText!,
        selectedOptionId: null,
        result: evaluation.result,
        viewedSource: 0,
        feedback: null,
        correctionJson: JSON.stringify({
          segments: evaluation.segments,
          corrected: evaluation.correctedSentence,
          better: evaluation.betterVersion,
        }),
        explanation: evaluation.explanation,
        betterVersion: evaluation.betterVersion,
        aiPromptKey: evaluation.promptMeta.key,
        aiPromptVersion: evaluation.promptMeta.version,
        aiPromptHash: evaluation.promptMeta.hash,
        aiModel: evaluation.promptMeta.model,
        preStateJson: null,
        postStateJson: null,
        createdAt: nowIso,
        voidedAt: null,
      })
      .run();
    // 优质 corrected 句仍可进入 Personal Example（PRODUCT §4.4）
    const saved = maybeSavePersonalExample(
      tx,
      itemId,
      {
        result: evaluation.result,
        eligible: evaluation.candidate.eligible,
        qualityScore: evaluation.candidate.qualityScore,
        correctedSentence: evaluation.correctedSentence,
        originalText: body.answerText!,
        betterVersion: evaluation.betterVersion,
      },
      now,
    );
    trimProductionHistory(tx, itemId);
    return saved;
  });

  return {
    result: evaluation.result,
    correct: evaluation.result !== 'fail',
    explanation: evaluation.explanation,
    correctOptionId: null,
    completeSentence: null,
    acceptedAnswer: null,
    correction: {
      segments: evaluation.segments,
      correctedSentence: evaluation.correctedSentence,
      betterVersion: evaluation.betterVersion,
    },
    personalExampleSaved: personalSaved.saved,
  };
}
