import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type {
  PracticeAnswerRequest,
  PracticeAnswerResponse,
  PracticeQuestion,
  PracticeStartResponse,
} from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import { JobLockTimeoutError, withJobLock } from '../../db/job-lock.js';
import { attempts, learningExamples, learningItems, questions } from '../../db/schema.js';
import { AppError, appError } from '../../lib/errors.js';
import type {
  DbExecutor,
  ProductionEvaluation,
  QuestionPoolType,
  QuestionRow,
} from '../questions/service.js';
import { maybeSavePersonalExample, trimProductionHistory } from '../learning-items/service.js';
import { effectiveProductionEnabled } from '../review/goals.js';

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

function sourceExampleOf(db: AppDatabase, itemId: string): string | null {
  return (
    db
      .select()
      .from(learningExamples)
      .where(eq(learningExamples.learningItemId, itemId))
      .orderBy(asc(learningExamples.sortOrder), asc(learningExamples.createdAt))
      .all()
      .find((e) => e.kind === 'source')?.text ?? null
  );
}

/**
 * understanding 题行 → Recall 视图（V2 / Phase 9）：
 * 词面 + 原句 + Hint 降级选择题面；释义（item.meaning）绝不在此下发，
 * 只能通过作答响应揭示（no leak before reveal）。
 */
function toRecallQuestion(
  db: AppDatabase,
  question: QuestionRow,
  item: { id: string; target: string },
): PracticeQuestion {
  const options = choiceOptions(safePayload(question));
  return {
    qtype: 'recall',
    questionId: question.id,
    target: item.target,
    context: sourceExampleOf(db, item.id),
    hint: {
      questionId: question.id,
      kind: question.contextText ? 'context_meaning' : 'direct_meaning',
      context: question.contextText ?? null,
      question: question.promptText ?? `${item.target} 最接近什么意思？`,
      options:
        options.length >= 2
          ? options
          : [
              { id: 'o1', text: '—' },
              { id: 'o2', text: '——' },
            ],
    },
  };
}

/** production 题行 → 表达题视图（不泄漏 referenceAnswer） */
function toProductionQuestion(question: QuestionRow, target: string): PracticeQuestion {
  const payload = safePayload(question);
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
// POST /api/library/:id/practice（PRODUCT §4.4，V2）
// ---------------------------------------------------------------------------

/**
 * V2 练一下组卷（不建 session/task、不改正式进度）：
 * 恰好 [recall]（production 关）或 [recall, production]（production 开，
 * 由 effectiveProductionEnabled 决定：word 默认关 / chunk 默认开 / override 优先）。
 * 无 cloze（Phase 9 起 P 阶段题一律 production）。recall 必须可得，否则 502；
 * production 单独失败不阻断（容忍只出 recall）。
 */
export async function startLibraryPractice(
  db: AppDatabase,
  deps: PracticeDeps,
  itemId: string,
  now: Date,
): Promise<PracticeStartResponse> {
  const item = requireItem(db, itemId);

  const wanted: QuestionPoolType[] = effectiveProductionEnabled(item)
    ? ['understanding', 'production']
    : ['understanding'];

  const usedQuestionIds: string[] = [];
  const out: PracticeQuestion[] = [];
  // 持 question-generation 全局锁（与 today/start、daily-prefetch 互斥，避免并发重复生成）
  try {
    await withJobLock(db, 'question-generation', async () => {
      for (const type of wanted) {
        const q = await acquireWithGenerate(db, deps, itemId, type, now, usedQuestionIds);
        if (!q) continue; // production 单类失败不阻断 recall
        usedQuestionIds.push(q.id);
        out.push(
          type === 'understanding'
            ? toRecallQuestion(db, q, item)
            : toProductionQuestion(q, item.target),
        );
      }
    });
  } catch (err) {
    if (err instanceof JobLockTimeoutError) {
      throw appError('CONFLICT', '题目正在准备中，请稍候重试');
    }
    throw err;
  }
  if (!out.some((q) => q.qtype === 'recall')) {
    throw appError('AI_PROVIDER_ERROR', '暂时无法生成练习题，请稍后重试');
  }
  return { questions: out };
}

// ---------------------------------------------------------------------------
// POST /api/library/:id/practice/:questionId/answer
// ---------------------------------------------------------------------------

function insertAttempt(db: AppDatabase, values: typeof attempts.$inferInsert): void {
  db.transaction((tx) => {
    tx.insert(attempts).values(values).run();
  });
}

/**
 * 练习作答（PRODUCT §4.4）：不改 review_states / next_review_at / status、
 * 不造补强、不写 daily_stats；写 attempt（mode='library_practice'，review_task_id=null）。
 * Recall 判定与 Today 完全一致：recall→pass/fail；Hint 选择→对=basic_pass（assisted
 * 语义）/错=fail。作答响应揭示释义（reveal）。表达题优质句仍可入 Personal Example。
 */
export async function answerLibraryPractice(
  db: AppDatabase,
  deps: PracticeDeps,
  itemId: string,
  questionId: string,
  body: PracticeAnswerRequest,
  now: Date,
): Promise<PracticeAnswerResponse> {
  const item = requireItem(db, itemId);
  const question = db.select().from(questions).where(eq(questions.id, questionId)).get();
  if (!question || question.learningItemId !== itemId) {
    throw appError('NOT_FOUND', '题目不存在');
  }
  if (question.status !== 'fresh' && question.status !== 'active') {
    throw appError('CONFLICT', '该题目已失效，无法作答');
  }
  if (question.type === 'cloze') {
    // V2（Phase 9）练习不再出填空；旧 cloze 库存即便直答也拒绝（零写入）
    throw appError('CONFLICT', '练习已不支持填空题');
  }

  const nowIso = now.toISOString();

  // ---- Recall（understanding）：直判自评 / Hint 选择；作答后揭示释义 ----
  if (question.type === 'understanding') {
    if (!body.recall && !body.selectedOptionId) {
      throw appError('VALIDATION_ERROR', 'Recall 题必须提交 recall 或 selectedOptionId');
    }
    let correct: boolean;
    let result: PracticeAnswerResponse['result'];
    if (body.recall) {
      correct = body.recall === 'recalled';
      result = correct ? 'pass' : 'fail';
    } else {
      correct = deps.evaluateChoice(question, body.selectedOptionId!).correct === true;
      // 提示后对 = 基础通过（assisted）；仍错 = forgot（与 Today Recall 判定一致）
      result = correct ? 'basic_pass' : 'fail';
    }
    const explanation =
      !correct && typeof safePayload(question).explanation === 'string'
        ? (safePayload(question).explanation as string)
        : null;
    insertAttempt(db, {
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
    });
    return {
      result,
      correct,
      meaning: item.meaning, // reveal 只在作答后
      explanation,
      correctOptionId: body.selectedOptionId ? question.correctOptionId : null,
      completeSentence: null,
      acceptedAnswer: null,
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
    meaning: null,
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
