import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  DEFAULT_SETTINGS,
  EXTEND_BATCH_UNLIMITED,
  MAX_NEW_ITEMS_UNLIMITED,
  MAX_REINFORCEMENT_PER_ITEM_PER_SESSION,
  REINFORCEMENT_MIN_GAP,
  REINFORCEMENT_TAIL_RATIO,
  localDateString,
  type AnswerRequest,
  type AnswerResponse,
  type BadQuestionResponse,
  type CorrectionView,
  type LaterResponse,
  type TaskFeedbackResponse,
  type TodayActiveResponse,
  type TodayCompletedResponse,
  type TodayIdleResponse,
  type TodayProgress,
  type TodaySessionTasksResponse,
  type TodayStatusResponse,
  type TodaySummary,
  type TodayTaskView,
  type UndoResponse,
} from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import { JobLockTimeoutError, withJobLock } from '../../db/job-lock.js';
import {
  attempts,
  dailyStats,
  learningExamples,
  learningItems,
  questions,
  reviewSessions,
  reviewStates,
  reviewTasks,
  settings,
} from '../../db/schema.js';
import { AppError, appError } from '../../lib/errors.js';
import {
  invalidateQuestions,
  type DbExecutor,
  type DbTx,
  type ProductionEvaluation,
  type QuestionPoolType,
  type QuestionRow,
} from '../questions/service.js';
import { effectiveProductionEnabled, isMastered } from '../review/goals.js';
import { INACTIVE_SNAPSHOT } from '../review/service.js';
import {
  maybeSavePersonalExample,
  trimProductionHistory,
  type AttemptRowSnapshot,
  type ExampleRowSnapshot,
  type PersonalExampleSaveResult,
} from '../learning-items/service.js';

export type { QuestionRow };
type TaskRow = typeof reviewTasks.$inferSelect;
type SessionRow = typeof reviewSessions.$inferSelect;
type ReviewStateRow = typeof reviewStates.$inferSelect;
type Dimension = 'understanding' | 'production';
export type QuestionKind = QuestionPoolType;

// ---------------------------------------------------------------------------
// 依赖接口（review / questions 模块的适配层；默认绑定真实模块，测试可注入 fake）
// ---------------------------------------------------------------------------

/** 单维度复习状态快照（review_states 行的业务投影；D/S NULL=未激活） */
export interface DimSnapshot {
  difficulty: number | null;
  stability: number | null;
  reps: number;
  lapses: number;
  nextReviewAt: string | null;
  lastReviewAt: string | null;
  correctStreak: number;
  wrongStreak: number;
}

/** attempt 的 pre/post 状态快照（坏题/普通撤销依据，DATABASE.md §8） */
export interface StateSnapshot {
  reviewStates: {
    understanding: (DimSnapshot & { id: string }) | null;
    production: (DimSnapshot & { id: string }) | null;
  };
  itemStatus: string;
  queueState: string;
  /** Phase 5 起写入；旧快照（更早 attempts）无此字段，恢复时保持现值 */
  needsReinforcement?: 0 | 1;
  /** 仅 post：本次结算新增的补强任务 id */
  reinforcementTaskIds?: string[];
  /** 仅 post：本次结算写入的 Personal Example id（坏题撤销时删除该例句的依据） */
  personalExampleId?: string | null;
  /** 仅 post：本次实际插入的文本（撤销时用于精确检测用户是否编辑，旧快照无此字段） */
  personalExampleText?: string | null;
  /** 仅 post：本次沉淀替换掉的未固定个人例句行快照（普通撤销精确恢复；旧快照无此字段） */
  replacedPersonalExample?: ExampleRowSnapshot | null;
  /** 仅 post：本次结算被裁剪的表达历史 attempt 行快照（普通撤销在 10 条边界恢复；旧快照无此字段） */
  prunedProductionAttempts?: AttemptRowSnapshot[];
}

export type AdvanceKind = 'pass' | 'basic_pass' | 'fail';

/** maybeSavePersonalExample 的"未沉淀"结果（非表达题路径共用） */
const SKIP_PERSONAL: PersonalExampleSaveResult = {
  saved: false,
  replacedExampleId: null,
  exampleId: null,
  replacedExampleSnapshot: null,
};

/** review.advanceReviewState 的 outcome 入参 */
export interface ReviewOutcomeInput {
  kind: AdvanceKind;
  tooEasy?: boolean;
}

export interface EvaluateOutcome {
  correct: boolean;
}

/**
 * today 模块对 review / questions 模块的依赖契约（与两个模块的公开导出一致）：
 * - advance（= review.advanceReviewState）：同步事务内调用，读行→计算→写回→mastered 判定
 * - initial*（= review.initialUnderstandingAfterLearn / initialProductionActivation）：纯函数
 * - acquire（= questions.acquireQuestion）：同步取题并置 active（事务外调用）
 * - generate（= questions.generateQuestionsForItem）/ evaluateCloze / evaluateProduction
 *   （check_production 实时批改）：仅事务外调用
 */
export interface TodayDeps {
  advance(
    tx: DbTx,
    itemId: string,
    dimension: Dimension,
    outcome: ReviewOutcomeInput,
    now: Date,
  ): { pre: DimSnapshot | null; post: DimSnapshot };
  initialUnderstandingAfterLearn(outcome: ReviewOutcomeInput, now: Date): DimSnapshot;
  initialProductionActivation(now: Date): DimSnapshot;
  acquire(
    exec: DbExecutor,
    itemId: string,
    type: QuestionKind,
    now: Date,
    excludeQuestionIds?: string[],
  ): QuestionRow | null;
  generate(db: AppDatabase, itemId: string, type: QuestionKind): Promise<unknown>;
  evaluateChoice(question: QuestionRow, selectedOptionId: string): EvaluateOutcome;
  evaluateCloze(
    db: AppDatabase,
    question: QuestionRow,
    answerText: string,
  ): Promise<EvaluateOutcome>;
  /** 表达题批改（事务外）：失败抛错，由 answerTodayTask 归一化为 AI_PROVIDER_ERROR */
  evaluateProduction(
    db: AppDatabase,
    question: QuestionRow,
    answerText: string,
  ): Promise<ProductionEvaluation>;
}

// ---------------------------------------------------------------------------
// 真实模块绑定：动态 import（并行开发期允许模块尚未存在；tsc 不做静态检查）
// ---------------------------------------------------------------------------

const REVIEW_SERVICE_PATH = '../review/service.js';
const QUESTIONS_SERVICE_PATH = '../questions/service.js';

type UnknownModule = Record<string, unknown>;

function requireFn(mod: UnknownModule, name: string): (...args: unknown[]) => unknown {
  const f = mod[name];
  if (typeof f !== 'function') {
    throw new Error(`依赖模块缺少导出函数：${name}`);
  }
  return f as (...args: unknown[]) => unknown;
}

function toDimSnapshot(result: unknown): DimSnapshot {
  if (!result || typeof result !== 'object') {
    throw appError('INTERNAL', '复习状态返回值无效');
  }
  const r = result as Record<string, unknown>;
  return {
    difficulty: typeof r.difficulty === 'number' ? r.difficulty : null,
    stability: typeof r.stability === 'number' ? r.stability : null,
    reps: typeof r.reps === 'number' ? r.reps : 0,
    lapses: typeof r.lapses === 'number' ? r.lapses : 0,
    nextReviewAt: typeof r.nextReviewAt === 'string' ? r.nextReviewAt : null,
    lastReviewAt: typeof r.lastReviewAt === 'string' ? r.lastReviewAt : null,
    correctStreak: typeof r.correctStreak === 'number' ? r.correctStreak : 0,
    wrongStreak: typeof r.wrongStreak === 'number' ? r.wrongStreak : 0,
  };
}

/** 绑定真实 review / questions 模块（适配点：若对方签名有偏差，只改这里） */
export async function loadRealTodayDeps(): Promise<TodayDeps> {
  const review = (await import(REVIEW_SERVICE_PATH)) as UnknownModule;
  const questionsMod = (await import(QUESTIONS_SERVICE_PATH)) as UnknownModule;
  const runtimeMod = (await import('../../ai/runtime.js')) as UnknownModule;
  const getAiRuntime = runtimeMod.getAiRuntime as () => unknown;

  const advanceFn = requireFn(review, 'advanceReviewState');
  const initialUFn = requireFn(review, 'initialUnderstandingAfterLearn');
  const initialPFn = requireFn(review, 'initialProductionActivation');
  const acquireFn = requireFn(questionsMod, 'acquireQuestion');
  const generateFn = requireFn(questionsMod, 'generateQuestionsForItem');
  const evaluateChoiceFn = requireFn(questionsMod, 'evaluateChoice');
  const evaluateClozeFn = requireFn(questionsMod, 'evaluateCloze');
  const evaluateProductionFn = requireFn(questionsMod, 'evaluateProduction');

  return {
    advance: (tx, itemId, dimension, outcome, now) =>
      advanceFn(tx, itemId, dimension, outcome, now) as {
        pre: DimSnapshot | null;
        post: DimSnapshot;
      },
    initialUnderstandingAfterLearn: (outcome, now) => toDimSnapshot(initialUFn(outcome, now)),
    initialProductionActivation: (now) => toDimSnapshot(initialPFn(now)),
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

let cachedRealDeps: TodayDeps | null = null;
let depsOverride: TodayDeps | null = null;

export async function resolveTodayDeps(): Promise<TodayDeps> {
  if (depsOverride) return depsOverride;
  cachedRealDeps ??= await loadRealTodayDeps();
  return cachedRealDeps;
}

/** 测试专用依赖注入（生产不调用） */
export function setTodayDepsForTests(deps: TodayDeps | null): void {
  depsOverride = deps;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function requireTask(exec: DbExecutor, taskId: string): TaskRow {
  const task = exec.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get();
  if (!task) throw appError('NOT_FOUND', '任务不存在');
  return task;
}

function rowToDim(row: ReviewStateRow): DimSnapshot & { id: string } {
  return {
    id: row.id,
    difficulty: row.difficulty,
    stability: row.stability,
    reps: row.reps,
    lapses: row.lapses,
    nextReviewAt: row.nextReviewAt,
    lastReviewAt: row.lastReviewAt,
    correctStreak: row.correctStreak,
    wrongStreak: row.wrongStreak,
  };
}

function snapshotOf(exec: DbExecutor, itemId: string): StateSnapshot {
  const rows = exec
    .select()
    .from(reviewStates)
    .where(eq(reviewStates.learningItemId, itemId))
    .all();
  const item = exec.select().from(learningItems).where(eq(learningItems.id, itemId)).get();
  return {
    reviewStates: {
      understanding: rows.some((r) => r.dimension === 'understanding')
        ? rowToDim(rows.find((r) => r.dimension === 'understanding')!)
        : null,
      production: rows.some((r) => r.dimension === 'production')
        ? rowToDim(rows.find((r) => r.dimension === 'production')!)
        : null,
    },
    itemStatus: item?.status ?? 'active',
    queueState: item?.queueState ?? 'new',
    needsReinforcement: (item?.needsReinforcement ?? 0) === 1 ? 1 : 0,
  };
}

function parseSnapshot(json: string | null): StateSnapshot | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as StateSnapshot;
    return parsed && typeof parsed === 'object' && parsed.reviewStates ? parsed : null;
  } catch {
    return null;
  }
}

/** 撤销恢复用行值：旧快照（FSRS 前，无 D/S/reps/lapses 字段）对新字段保持现值（沿用 optional 兼容模式） */
function restoreDimValues(
  itemId: string,
  dim: Dimension,
  snap: Partial<DimSnapshot> & { id: string },
  current: ReviewStateRow | undefined,
  nowIso: string,
): typeof reviewStates.$inferInsert {
  // undefined=旧快照缺字段 → 保持现值；null 是合法值（未激活），必须原样恢复
  const keep = <T>(snapVal: T | undefined, currentVal: T | undefined, fallback: T): T =>
    snapVal === undefined ? (currentVal ?? fallback) : snapVal;
  return {
    id: snap.id,
    learningItemId: itemId,
    dimension: dim,
    difficulty: keep(snap.difficulty, current?.difficulty, null),
    stability: keep(snap.stability, current?.stability, null),
    reps: keep(snap.reps, current?.reps, 0),
    lapses: keep(snap.lapses, current?.lapses, 0),
    nextReviewAt: snap.nextReviewAt ?? null,
    lastReviewAt: snap.lastReviewAt ?? null,
    correctStreak: snap.correctStreak ?? 0,
    wrongStreak: snap.wrongStreak ?? 0,
    updatedAt: nowIso,
  };
}

/** 坏题撤销 / 反馈重算前：把单个维度恢复为快照值（快照为 null 则删除该行） */
function restoreDimState(
  exec: DbExecutor,
  itemId: string,
  dim: Dimension,
  snap: (DimSnapshot & { id: string }) | null,
  nowIso: string,
): void {
  const current = exec
    .select()
    .from(reviewStates)
    .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dim)))
    .get();
  exec
    .delete(reviewStates)
    .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dim)))
    .run();
  if (snap) {
    exec
      .insert(reviewStates)
      .values(restoreDimValues(itemId, dim, snap, current, nowIso))
      .run();
  }
}

/** 将某维度状态写回 review_states（upsert，保留既有行 id） */
function writeDimState(
  exec: DbExecutor,
  itemId: string,
  dim: Dimension,
  next: DimSnapshot,
  nowIso: string,
): void {
  const values = {
    difficulty: next.difficulty,
    stability: next.stability,
    reps: next.reps,
    lapses: next.lapses,
    nextReviewAt: next.nextReviewAt,
    lastReviewAt: next.lastReviewAt,
    correctStreak: next.correctStreak,
    wrongStreak: next.wrongStreak,
    updatedAt: nowIso,
  };
  const existing = exec
    .select()
    .from(reviewStates)
    .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dim)))
    .get();
  if (existing) {
    exec.update(reviewStates).set(values).where(eq(reviewStates.id, existing.id)).run();
  } else {
    exec
      .insert(reviewStates)
      .values({ id: randomUUID(), learningItemId: itemId, dimension: dim, ...values })
      .run();
  }
}

/** 坏题撤销：按 pre 快照恢复两维状态、item.status 与 queue_state（含 Read 补强旗回滚） */
function restoreSnapshot(
  exec: DbExecutor,
  itemId: string,
  snap: StateSnapshot,
  nowIso: string,
): void {
  for (const dim of ['understanding', 'production'] as const) {
    const current = exec
      .select()
      .from(reviewStates)
      .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dim)))
      .get();
    exec
      .delete(reviewStates)
      .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dim)))
      .run();
    const pre = snap.reviewStates[dim];
    if (pre) {
      exec
        .insert(reviewStates)
        .values(restoreDimValues(itemId, dim, pre, current, nowIso))
        .run();
    }
  }
  exec
    .update(learningItems)
    .set({
      status: snap.itemStatus,
      queueState: snap.queueState,
      // 旧快照无此字段时保持现值（Phase 5 前的 attempts）
      ...(snap.needsReinforcement === undefined
        ? {}
        : { needsReinforcement: snap.needsReinforcement }),
      updatedAt: nowIso,
    })
    .where(eq(learningItems.id, itemId))
    .run();
}

interface StatsDelta {
  formal?: number;
  newItems?: number;
  productionAttempts?: number;
  productionPass?: number;
}

function bumpDailyStats(exec: DbExecutor, date: string, delta: StatsDelta, nowIso: string): void {
  const row = exec.select().from(dailyStats).where(eq(dailyStats.date, date)).get();
  const next = {
    formalTasksCompleted: Math.max(0, (row?.formalTasksCompleted ?? 0) + (delta.formal ?? 0)),
    newItemsStarted: Math.max(0, (row?.newItemsStarted ?? 0) + (delta.newItems ?? 0)),
    productionAttempts: Math.max(
      0,
      (row?.productionAttempts ?? 0) + (delta.productionAttempts ?? 0),
    ),
    productionPass: Math.max(0, (row?.productionPass ?? 0) + (delta.productionPass ?? 0)),
  };
  if (row) {
    exec
      .update(dailyStats)
      .set({ ...next, updatedAt: nowIso })
      .where(eq(dailyStats.date, date))
      .run();
  } else {
    exec
      .insert(dailyStats)
      .values({ date, ...next, updatedAt: nowIso })
      .run();
  }
}

function progressOf(exec: DbExecutor, sessionId: string): TodayProgress {
  const tasks = exec.select().from(reviewTasks).where(eq(reviewTasks.sessionId, sessionId)).all();
  const live = tasks.filter((t) => t.canceledAt === null);
  return {
    completed: live.filter((t) => t.completedAt !== null).length,
    total: live.length,
  };
}

/** Library 关闭造句目标时，在同一事务取消今天尚未作答的 P 任务。 */
export function cancelPendingProductionTasksForItem(
  tx: DbTx,
  itemId: string,
  sessionDate: string,
  nowIso: string,
): void {
  const session = tx
    .select()
    .from(reviewSessions)
    .where(eq(reviewSessions.sessionDate, sessionDate))
    .get();
  if (!session) return;
  tx.update(reviewTasks)
    .set({ canceledAt: nowIso })
    .where(
      and(
        eq(reviewTasks.sessionId, session.id),
        eq(reviewTasks.learningItemId, itemId),
        eq(reviewTasks.dimension, 'production'),
        isNull(reviewTasks.completedAt),
        isNull(reviewTasks.canceledAt),
      ),
    )
    .run();
  const live = tx
    .select()
    .from(reviewTasks)
    .where(and(eq(reviewTasks.sessionId, session.id), isNull(reviewTasks.canceledAt)))
    .all();
  const baseTaskCount = live.filter((task) => task.origin === 'base').length;
  const completedAt = live.every((task) => task.completedAt !== null)
    ? (session.completedAt ?? nowIso)
    : null;
  tx.update(reviewSessions)
    .set({ baseTaskCount, completedAt })
    .where(eq(reviewSessions.id, session.id))
    .run();
}

/** 完成摘要：计数来自该 session 的非 void attempts（PRODUCT_DESIGN §4.3） */
function buildSummary(exec: DbExecutor, session: SessionRow): TodaySummary {
  const tasks = exec.select().from(reviewTasks).where(eq(reviewTasks.sessionId, session.id)).all();
  const live = tasks.filter((t) => t.canceledAt === null);
  const taskIds = live.map((t) => t.id);
  let pass = 0;
  let basicPass = 0;
  let fail = 0;
  if (taskIds.length > 0) {
    const rows = exec.select().from(attempts).where(inArray(attempts.reviewTaskId, taskIds)).all();
    for (const a of rows) {
      if (a.voidedAt !== null || a.result === 'void') continue;
      if (a.result === 'pass') pass += 1;
      else if (a.result === 'basic_pass') basicPass += 1;
      else if (a.result === 'fail') fail += 1;
    }
  }
  return {
    totalTasks: live.length,
    pass,
    basicPass,
    fail,
    newItemsStarted: live.filter((t) => t.taskType === 'learn' && t.completedAt !== null).length,
    recommendRead: fail > 0,
  };
}

// ---------------------------------------------------------------------------
// 题目视图与揭示
// ---------------------------------------------------------------------------

interface QuestionPayload {
  options?: Array<{ id: string; text: string }>;
  acceptedAnswers?: string[];
  explanation?: string;
  mustUse?: string;
  referenceAnswer?: string;
  acceptanceNotes?: string;
}

function safePayload(question: QuestionRow): QuestionPayload {
  try {
    const parsed = JSON.parse(question.payloadJson) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as QuestionPayload) : {};
  } catch {
    return {};
  }
}

function choiceOptions(payload: QuestionPayload): Array<{ id: string; text: string }> | null {
  if (!Array.isArray(payload.options)) return null;
  const opts = payload.options.filter(
    (o): o is { id: string; text: string } =>
      !!o && typeof o === 'object' && typeof o.id === 'string' && typeof o.text === 'string',
  );
  return opts.length >= 2 ? opts : null;
}

function clozeReveal(question: QuestionRow): {
  completeSentence: string;
  acceptedAnswer: string | null;
} {
  const payload = safePayload(question);
  const accepted = Array.isArray(payload.acceptedAnswers)
    ? payload.acceptedAnswers.filter((a): a is string => typeof a === 'string')
    : [];
  const canonical = accepted[0] ?? null;
  // questions 模块约定：cloze 的 text_with_blank 存 promptText（contextText 恒 null）
  const textWithBlank = question.promptText ?? question.contextText ?? '';
  const completeSentence =
    canonical !== null ? textWithBlank.replace(/_{2,}/, canonical) : textWithBlank;
  return { completeSentence, acceptedAnswer: canonical };
}

/** explanation 只在错误时揭示（choice 错误 / cloze 揭示，PRODUCT_DESIGN §7.6） */
function revealExplanation(question: QuestionRow, correct: boolean): string | null {
  if (correct) return null;
  return safePayload(question).explanation ?? null;
}

/**
 * 表达题主动不会揭示（TECHNICAL_DESIGN §7.5）：参考句与目标用法说明
 * 全部来自绑定题目 payload（reference_answer / acceptance_notes），不伪造批改结果。
 * 仅在作答后返回——TodayTaskView 等未作答视图绝不调用本函数。
 */
function productionReveal(question: QuestionRow): {
  referenceAnswer: string | null;
  answerNote: string | null;
} {
  const payload = safePayload(question);
  return {
    referenceAnswer:
      typeof payload.referenceAnswer === 'string' && payload.referenceAnswer
        ? payload.referenceAnswer
        : null,
    answerNote:
      typeof payload.acceptanceNotes === 'string' && payload.acceptanceNotes
        ? payload.acceptanceNotes
        : null,
  };
}

function taskToView(exec: DbExecutor, task: TaskRow): TodayTaskView {
  const item = exec
    .select()
    .from(learningItems)
    .where(eq(learningItems.id, task.learningItemId))
    .get();
  if (!item) throw appError('INTERNAL', '学习项不存在');
  const examples = exec
    .select()
    .from(learningExamples)
    .where(eq(learningExamples.learningItemId, task.learningItemId))
    .orderBy(asc(learningExamples.sortOrder), asc(learningExamples.createdAt))
    .all();
  const sourceExample = examples.find((e) => e.kind === 'source')?.text ?? null;

  let supplementaryExamples: string[] = [];
  if (task.taskType === 'learn') {
    // learn 卡最多展示 1 条补充/个人例句（TodayTaskView 契约）
    const extra = examples.find((e) => e.kind === 'extra');
    const personal = examples.find((e) => e.kind === 'personal');
    const pick = extra ?? personal;
    supplementaryExamples = pick ? [pick.text] : [];
  }

  let question = task.questionId
    ? (exec.select().from(questions).where(eq(questions.id, task.questionId)).get() ?? null)
    : null;
  // 待答旧题失效后重新进入 prepare；已答/已撤销记录仍保留原题用于历史回看。
  if (
    task.completedAt === null &&
    task.canceledAt === null &&
    question &&
    ((question.status !== 'fresh' && question.status !== 'active') ||
      question.meaningSnapshot !== item.meaning)
  ) {
    question = null;
  }
  let questionView: TodayTaskView['question'] = null;
  if (question && question.type === 'understanding') {
    const options = choiceOptions(safePayload(question));
    if (options) {
      questionView = {
        questionId: question.id,
        kind: question.contextText ? 'context_meaning' : 'direct_meaning',
        context: question.contextText ?? null,
        question: question.promptText ?? `${item.target} 最接近什么意思？`,
        options,
      };
    }
  } else if (question && question.type === 'cloze') {
    questionView = {
      questionId: question.id,
      textWithBlank: question.promptText ?? question.contextText ?? '',
    };
  } else if (question && question.type === 'production') {
    // 表达题视图：只暴露中文题干与 must_use；reference_answer 绝不下发（AI_RULES §9）
    const payload = safePayload(question);
    if (typeof payload.mustUse === 'string' && payload.mustUse) {
      questionView = {
        questionId: question.id,
        zhPrompt: question.promptText ?? '',
        mustUse: payload.mustUse,
      };
    }
  }

  return {
    taskId: task.id,
    taskType: task.taskType as 'learn' | 'understanding' | 'cloze' | 'production',
    dimension: task.dimension as Dimension,
    origin: task.origin as TodayTaskView['origin'],
    deferCount: task.deferCount,
    item: {
      id: item.id,
      type: item.type as 'word' | 'chunk',
      target: item.target,
      meaning: item.meaning,
      ipa: item.ipa,
      notes: item.notes,
    },
    sourceExample,
    supplementaryExamples,
    question: questionView,
  };
}

// ---------------------------------------------------------------------------
// 混排（PRODUCT_DESIGN §4.3 / §5.1：同 item 不相邻、同题型连续 ≤3）
// ---------------------------------------------------------------------------

const MAX_CONSECUTIVE_SAME_TYPE = 3;
const TYPE_ORDER: Record<string, number> = { learn: 0, understanding: 1, cloze: 2, production: 3 };

export interface InterleavableTask {
  itemId: string;
  taskType: 'learn' | 'understanding' | 'cloze' | 'production';
}

export function interleaveTasks<T extends InterleavableTask>(tasks: T[]): T[] {
  // 1) 按 item 分组（组序 = 首次出现顺序）；组内 learn → understanding → cloze
  const groups = new Map<string, T[]>();
  for (const t of tasks) {
    const g = groups.get(t.itemId);
    if (g) g.push(t);
    else groups.set(t.itemId, [t]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => (TYPE_ORDER[a.taskType] ?? 9) - (TYPE_ORDER[b.taskType] ?? 9));
  }

  // 2) 组间轮转：每轮从每个非空组取一个 → 同 item 任务被其它 item 隔开
  const ordered: T[] = [];
  const queues = [...groups.values()];
  for (;;) {
    let pushed = 0;
    for (const q of queues) {
      if (q.length === 0) continue;
      ordered.push(q.shift()!);
      pushed += 1;
    }
    if (pushed === 0) break;
  }

  // 3) 类型打散：同一题型连续不超过 3；优先选择不制造相邻同 item 的交换对象
  for (let i = 0; i < ordered.length; i += 1) {
    let run = 1;
    while (i - run >= 0 && ordered[i - run]!.taskType === ordered[i]!.taskType) run += 1;
    if (run <= MAX_CONSECUTIVE_SAME_TYPE) continue;
    const cur = ordered[i]!;
    let swapIdx = -1;
    for (let j = i + 1; j < ordered.length; j += 1) {
      const cand = ordered[j]!;
      if (cand.taskType === cur.taskType) continue;
      const prev = ordered[i - 1]!;
      const next = ordered[i + 1];
      if (next && (cand.itemId === prev.itemId || cand.itemId === next.itemId)) continue;
      swapIdx = j;
      break;
    }
    if (swapIdx === -1) {
      // 退而求其次：只要求类型不同（题量不足以完美打散时保持原序）
      for (let j = i + 1; j < ordered.length; j += 1) {
        if (ordered[j]!.taskType !== cur.taskType) {
          swapIdx = j;
          break;
        }
      }
    }
    if (swapIdx === -1) break;
    [ordered[i], ordered[swapIdx]] = [ordered[swapIdx], ordered[i]];
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// GET /api/today：三态
// ---------------------------------------------------------------------------

function readMaxNewItemsPerDay(exec: DbExecutor): number {
  const row = exec.select().from(settings).get();
  return row?.maxNewItemsPerDay ?? DEFAULT_SETTINGS.maxNewItemsPerDay;
}

function activeResponse(exec: DbExecutor, session: SessionRow): TodayActiveResponse {
  const current = exec
    .select()
    .from(reviewTasks)
    .where(
      and(
        eq(reviewTasks.sessionId, session.id),
        isNull(reviewTasks.completedAt),
        isNull(reviewTasks.canceledAt),
      ),
    )
    .orderBy(asc(reviewTasks.sortKey))
    .limit(1)
    .get();
  return {
    status: 'active',
    session: { id: session.id, sessionDate: session.sessionDate },
    progress: progressOf(exec, session.id),
    currentTask: current ? taskToView(exec, current) : null,
  };
}

function idleResponse(db: AppDatabase, timezone: string, now: Date): TodayIdleResponse {
  const nowIso = now.toISOString();
  const dueRows = db
    .select({
      dimension: reviewStates.dimension,
      type: learningItems.type,
      productionEnabledOverride: learningItems.productionEnabledOverride,
    })
    .from(reviewStates)
    .innerJoin(learningItems, eq(learningItems.id, reviewStates.learningItemId))
    .where(
      and(
        eq(learningItems.status, 'active'),
        eq(learningItems.queueState, 'started'),
        isNotNull(reviewStates.nextReviewAt),
        lte(reviewStates.nextReviewAt, nowIso),
      ),
    )
    .all();
  const dueItems = dueRows.filter(
    (row) => row.dimension !== 'production' || effectiveProductionEnabled(row),
  ).length;

  const today = localDateString(now, timezone);
  const maxNew = readMaxNewItemsPerDay(db);
  // "N new today" 语义（PRODUCT §5.1）：今日实际会引入的新项数 = min(剩余额度, New Queue 可用数)
  const [{ candidates }] = db
    .select({ candidates: sql<number>`count(*)` })
    .from(learningItems)
    .where(and(eq(learningItems.status, 'active'), eq(learningItems.queueState, 'new')))
    .all();
  let newTodayAvailable: number;
  if (maxNew === MAX_NEW_ITEMS_UNLIMITED) {
    newTodayAvailable = candidates;
  } else {
    const stats = db.select().from(dailyStats).where(eq(dailyStats.date, today)).get();
    newTodayAvailable = Math.min(candidates, Math.max(0, maxNew - (stats?.newItemsStarted ?? 0)));
  }

  // recentlyLearned：最近完成的 Learn 任务对应项；无历史时退化为最近创建的 started 项
  let recent = db
    .select({ id: learningItems.id, target: learningItems.target, type: learningItems.type })
    .from(reviewTasks)
    .innerJoin(learningItems, eq(learningItems.id, reviewTasks.learningItemId))
    .where(
      and(
        eq(reviewTasks.taskType, 'learn'),
        isNotNull(reviewTasks.completedAt),
        ne(learningItems.status, 'archived'),
      ),
    )
    .orderBy(desc(reviewTasks.completedAt), desc(learningItems.id))
    .limit(5)
    .all();
  if (recent.length === 0) {
    recent = db
      .select({ id: learningItems.id, target: learningItems.target, type: learningItems.type })
      .from(learningItems)
      .where(and(eq(learningItems.queueState, 'started'), ne(learningItems.status, 'archived')))
      .orderBy(desc(learningItems.createdAt), desc(learningItems.id))
      .limit(5)
      .all();
  }

  const { totalItems, newQueueCount } = libraryCountsOf(db);

  return {
    status: 'idle',
    dueItems,
    newTodayAvailable,
    totalItems,
    newQueueCount,
    recentlyLearned: recent.map((r) => ({
      id: r.id,
      target: r.target,
      type: r.type as 'word' | 'chunk',
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/today/tasks：会话全部任务批量视图（进度/回看/完成页今日回顾）
// ---------------------------------------------------------------------------

/**
 * 会话内最近一次非 void 的 Today attempt 及其任务（撤销目标定位，TECHNICAL_DESIGN §7.5）。
 * 用 SQLite rowid DESC 判插入序——任务 sortKey/UUID/毫秒时间戳都可能并列，不可作依据。
 */
function latestSessionAttempt(
  exec: DbExecutor,
  sessionId: string,
): { attempt: AttemptRowSnapshot; task: TaskRow } | null {
  const row = exec
    .select({ attempt: attempts, task: reviewTasks })
    .from(attempts)
    .innerJoin(reviewTasks, eq(reviewTasks.id, attempts.reviewTaskId))
    .where(
      and(
        eq(reviewTasks.sessionId, sessionId),
        eq(attempts.mode, 'today'),
        isNull(attempts.voidedAt),
        ne(attempts.result, 'void'),
      ),
    )
    .orderBy(sql`"attempts"."rowid" DESC`)
    .limit(1)
    .get();
  return row ?? null;
}

export async function getSessionTasks(
  db: AppDatabase,
  timezone: string,
  now: Date,
): Promise<TodaySessionTasksResponse> {
  const today = localDateString(now, timezone);
  const session = db
    .select()
    .from(reviewSessions)
    .where(eq(reviewSessions.sessionDate, today))
    .get();
  if (!session) throw appError('CONFLICT', '今日没有复习会话');
  const tasks = db
    .select()
    .from(reviewTasks)
    .where(eq(reviewTasks.sessionId, session.id))
    .orderBy(asc(reviewTasks.sortKey))
    .all();
  // 撤销入口只指向最近一次有效作答（普通撤销仅限当日内、下一次作答前，PRODUCT §5.1）
  const undoable = latestSessionAttempt(db, session.id);
  return {
    tasks: tasks.map((task) => ({
      task: taskToView(db, task),
      // 已撤销（含撤销前的作答）不回放结果：attempt 已 void，题面仅用于回看
      result: task.canceledAt === null && task.completedAt !== null ? replayAnswer(db, task) : null,
      canceled: task.canceledAt !== null,
    })),
    undoableTaskId: undoable?.attempt.reviewTaskId ?? null,
  };
}

export function getTodayStatus(db: AppDatabase, timezone: string, now: Date): TodayStatusResponse {
  const today = localDateString(now, timezone);
  const session = db
    .select()
    .from(reviewSessions)
    .where(eq(reviewSessions.sessionDate, today))
    .get();
  if (!session) return idleResponse(db, timezone, now);
  if (session.completedAt !== null) {
    return {
      status: 'completed',
      summary: buildSummary(db, session),
      remainingNewQuota: remainingNewQuotaOf(db, today),
      ...libraryCountsOf(db),
    };
  }
  return activeResponse(db, session);
}

// ---------------------------------------------------------------------------
// POST /api/today/start
// ---------------------------------------------------------------------------

interface PlanTask {
  itemId: string;
  dimension: Dimension;
  taskType: 'learn' | 'understanding' | 'cloze' | 'production';
  questionId: string | null;
  origin: 'base' | 'read_reinforcement';
}

/** 事务外取题：无库存时懒生成；AI 失败返回 null，业务冲突原样抛出。 */
async function acquireWithGenerate(
  db: AppDatabase,
  deps: TodayDeps,
  itemId: string,
  type: QuestionKind,
  now: Date,
  excludeQuestionIds?: string[],
): Promise<QuestionRow | null> {
  const direct = deps.acquire(db, itemId, type, now, excludeQuestionIds);
  if (direct) return direct;
  try {
    await deps.generate(db, itemId, type);
  } catch (err) {
    if (err instanceof AppError && err.code === 'CONFLICT') throw err;
    console.warn(`[today] 题目生成失败（item=${itemId} type=${type}）：${(err as Error).message}`);
    return null;
  }
  return deps.acquire(db, itemId, type, now, excludeQuestionIds);
}

/** 进程内串行化（双击/多标签同进程），跨进程由 uq_review_sessions_date 兜底 */
let startChain: Promise<unknown> = Promise.resolve();

/** start 响应：与 GET /api/today 同契约（completed 必带 remainingNewQuota） */
type StartResponse = TodayActiveResponse | TodayCompletedResponse;

export async function startTodaySession(
  db: AppDatabase,
  deps: TodayDeps,
  timezone: string,
  now: Date,
): Promise<StartResponse> {
  const run = startChain.then(
    () => startTodaySessionInner(db, deps, timezone, now),
    () => startTodaySessionInner(db, deps, timezone, now),
  );
  startChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function startTodaySessionInner(
  db: AppDatabase,
  _deps: TodayDeps,
  timezone: string,
  now: Date,
): Promise<StartResponse> {
  const today = localDateString(now, timezone);
  const existing = db
    .select()
    .from(reviewSessions)
    .where(eq(reviewSessions.sessionDate, today))
    .get();
  if (existing) {
    // 幂等：今日已有 session，直接返回当前状态（active / completed，completed 带剩余额度）
    return existing.completedAt !== null
      ? {
          status: 'completed',
          summary: buildSummary(db, existing),
          remainingNewQuota: remainingNewQuotaOf(db, today),
          ...libraryCountsOf(db),
        }
      : activeResponse(db, existing);
  }

  const nowIso = now.toISOString();

  // ---- 1) 到期维度任务（active+started，next_review_at<=now；事务外只读）----
  const dueRows = db
    .select({ state: reviewStates, item: learningItems })
    .from(reviewStates)
    .innerJoin(learningItems, eq(learningItems.id, reviewStates.learningItemId))
    .where(
      and(
        eq(learningItems.status, 'active'),
        eq(learningItems.queueState, 'started'),
        isNotNull(reviewStates.nextReviewAt),
        lte(reviewStates.nextReviewAt, nowIso),
      ),
    )
    .orderBy(asc(reviewStates.nextReviewAt), asc(learningItems.id))
    .all();

  // ---- 2) New Queue 候选与剩余额度 ----
  const maxNew = readMaxNewItemsPerDay(db);
  const newCandidates = db
    .select()
    .from(learningItems)
    .where(and(eq(learningItems.status, 'active'), eq(learningItems.queueState, 'new')))
    .orderBy(asc(learningItems.createdAt), asc(learningItems.id))
    .all();
  const stats = db.select().from(dailyStats).where(eq(dailyStats.date, today)).get();
  const remainingQuota =
    maxNew === MAX_NEW_ITEMS_UNLIMITED
      ? newCandidates.length
      : Math.max(0, maxNew - (stats?.newItemsStarted ?? 0));
  const learnItems = newCandidates.slice(0, remainingQuota);

  // ---- 3) 先创建所有 pending 任务；取题只在 prepare 阶段进行 ----
  const plans: PlanTask[] = [];
  for (const row of dueRows) {
    if (row.state.dimension === 'production' && !effectiveProductionEnabled(row.item)) continue;
    const dimension = row.state.dimension as Dimension;
    plans.push({
      itemId: row.item.id,
      dimension,
      taskType: dimension === 'understanding' ? 'understanding' : 'production',
      questionId: null,
      origin: 'base',
    });
  }
  for (const item of learnItems) {
    plans.push({
      itemId: item.id,
      dimension: 'understanding',
      taskType: 'learn',
      questionId: null,
      origin: 'base',
    });
  }

  // ---- 4) 混排 + 同步事务落库 ----
  const ordered = interleaveTasks(plans);
  const create = (): StartResponse =>
    db.transaction((tx) => {
      const sessionId = randomUUID();
      const empty = ordered.length === 0;
      tx.insert(reviewSessions)
        .values({
          id: sessionId,
          sessionDate: today,
          startedAt: nowIso,
          completedAt: empty ? nowIso : null,
          baseTaskCount: ordered.length,
          newItemsStarted: 0,
          createdAt: nowIso,
        })
        .run();
      ordered.forEach((p, index) => {
        tx.insert(reviewTasks)
          .values({
            id: randomUUID(),
            sessionId,
            learningItemId: p.itemId,
            dimension: p.dimension,
            questionId: p.questionId,
            taskType: p.taskType,
            origin: p.origin,
            sortKey: index + 1,
            deferCount: 0,
            completedAt: null,
            canceledAt: null,
            createdAt: nowIso,
          })
          .run();
      });
      const session = tx
        .select()
        .from(reviewSessions)
        .where(eq(reviewSessions.id, sessionId))
        .get();
      if (!session) throw appError('INTERNAL', '会话创建失败');
      if (empty) {
        // 空会话直接完成，避免出现永远无法满足完成条件的 0/0 会话
        return {
          status: 'completed',
          summary: buildSummary(tx, session),
          remainingNewQuota: remainingNewQuotaOf(tx, today),
          ...libraryCountsOf(tx),
        };
      }
      return activeResponse(tx, session);
    });

  try {
    return create();
  } catch (err) {
    // 并发兜底：session_date 唯一索引冲突 → 按既有 session 幂等返回
    const again = db
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.sessionDate, today))
      .get();
    if (again) {
      return again.completedAt !== null
        ? {
            status: 'completed',
            summary: buildSummary(db, again),
            remainingNewQuota: remainingNewQuotaOf(db, today),
            ...libraryCountsOf(db),
          }
        : activeResponse(db, again);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /api/today/extend：同日追加学习
// ---------------------------------------------------------------------------

/** 词库计数：active 总数与 New Queue 待学数（idle/completed 展示共用） */
function libraryCountsOf(db: DbExecutor): { totalItems: number; newQueueCount: number } {
  const totalItems = db
    .select({ n: sql<number>`count(*)` })
    .from(learningItems)
    .where(eq(learningItems.status, 'active'))
    .get()?.n as number;
  const newQueueCount = db
    .select({ n: sql<number>`count(*)` })
    .from(learningItems)
    .where(and(eq(learningItems.status, 'active'), eq(learningItems.queueState, 'new')))
    .get()?.n as number;
  return { totalItems, newQueueCount };
}

/** 剩余新学额度（maxNew − 今日 newItemsStarted；不限制返回 null，0=用尽） */
function remainingNewQuotaOf(db: DbExecutor, sessionDate: string): number | null {
  const maxNew = readMaxNewItemsPerDay(db);
  const started =
    db.select().from(dailyStats).where(eq(dailyStats.date, sessionDate)).get()?.newItemsStarted ??
    0;
  if (maxNew === MAX_NEW_ITEMS_UNLIMITED) return null;
  return Math.max(0, maxNew - started);
}

/**
 * 同日追加学习（PRODUCT §3.4）：已完成会话 + 额度剩余 → 追加一批 Learn 任务并重新激活。
 * 调度/统计零改动：追加任务与正常 Learn 同路径（answer 时结算/计数/完成检测）。
 * 追加 pending Learn 与 start 共用懒绑定路径，生成失败不影响任务与额度。
 */
export async function extendTodaySession(
  db: AppDatabase,
  _deps: TodayDeps,
  timezone: string,
  now: Date,
): Promise<TodayActiveResponse> {
  const today = localDateString(now, timezone);
  const session = db
    .select()
    .from(reviewSessions)
    .where(eq(reviewSessions.sessionDate, today))
    .get();
  if (!session) throw appError('CONFLICT', '今日没有复习会话');
  if (session.completedAt === null) throw appError('CONFLICT', '会话尚未完成，无需追加');

  const remaining = remainingNewQuotaOf(db, today);
  if (remaining === 0) throw appError('CONFLICT', '今日新学习额度已用完');
  const count = remaining ?? EXTEND_BATCH_UNLIMITED;

  // 取词与 start 同序（queue_state='new'、active、createdAt,id），按剩余额度截断
  const candidates = db
    .select()
    .from(learningItems)
    .where(and(eq(learningItems.status, 'active'), eq(learningItems.queueState, 'new')))
    .orderBy(asc(learningItems.createdAt), asc(learningItems.id))
    .limit(count)
    .all();
  if (candidates.length === 0) throw appError('CONFLICT', '没有可学的新词');

  const nowIso = now.toISOString();
  return db.transaction((tx) => {
    // 事务内复查：会话仍处于完成态（并发下可能已被重新激活）
    const fresh = tx.select().from(reviewSessions).where(eq(reviewSessions.id, session.id)).get();
    if (!fresh) throw appError('INTERNAL', '会话不存在');
    if (fresh.completedAt === null) throw appError('CONFLICT', '会话已被重新激活');
    // 追加任务接在当日队列末尾（sortKey 从当前最大值起递增）
    const maxSort =
      tx
        .select({ m: sql<number>`max(${reviewTasks.sortKey})` })
        .from(reviewTasks)
        .where(eq(reviewTasks.sessionId, session.id))
        .get()?.m ?? 0;
    candidates.forEach((item, index) => {
      tx.insert(reviewTasks)
        .values({
          id: randomUUID(),
          sessionId: session.id,
          learningItemId: item.id,
          dimension: 'understanding',
          questionId: null,
          taskType: 'learn',
          origin: 'base',
          sortKey: maxSort + index + 1,
          deferCount: 0,
          completedAt: null,
          canceledAt: null,
          createdAt: nowIso,
        })
        .run();
    });
    tx.update(reviewSessions)
      .set({ completedAt: null })
      .where(eq(reviewSessions.id, session.id))
      .run();
    const updated = tx.select().from(reviewSessions).where(eq(reviewSessions.id, session.id)).get();
    if (!updated) throw appError('INTERNAL', '会话不存在');
    return activeResponse(tx, updated);
  });
}

/** 同日任务按需取题；AI/库存获取在写事务外，最后只比较并绑定一个有效题目。 */
export async function prepareTodayTask(
  db: AppDatabase,
  deps: TodayDeps,
  timezone: string,
  now: Date,
  taskId: string,
): Promise<TodayTaskView> {
  const validate = (
    exec: DbExecutor,
  ): { task: TaskRow; item: typeof learningItems.$inferSelect } => {
    const task = requireTask(exec, taskId);
    const session = exec
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.id, task.sessionId))
      .get();
    const item = exec
      .select()
      .from(learningItems)
      .where(eq(learningItems.id, task.learningItemId))
      .get();
    if (!session || !item) throw appError('CONFLICT', '任务已失效，请刷新今日学习');
    if (
      session.sessionDate !== localDateString(now, timezone) ||
      session.completedAt !== null ||
      task.completedAt !== null ||
      task.canceledAt !== null ||
      item.status !== 'active' ||
      (task.taskType === 'learn' ? item.queueState !== 'new' : item.queueState !== 'started') ||
      (task.dimension === 'production' && !effectiveProductionEnabled(item))
    ) {
      throw appError('CONFLICT', '任务已失效，请刷新今日学习');
    }
    return { task, item };
  };
  const validQuestion = (exec: DbExecutor, task: TaskRow, meaning: string): boolean => {
    if (!task.questionId) return false;
    const question = exec.select().from(questions).where(eq(questions.id, task.questionId)).get();
    return Boolean(
      question &&
      question.learningItemId === task.learningItemId &&
      question.type === (task.taskType === 'learn' ? 'understanding' : task.taskType) &&
      (question.status === 'fresh' || question.status === 'active') &&
      question.meaningSnapshot === meaning,
    );
  };

  const initial = validate(db);
  if (initial.task.questionId && validQuestion(db, initial.task, initial.item.meaning)) {
    return taskToView(db, initial.task);
  }
  try {
    return await withJobLock(db, 'question-generation', async () => {
      const current = validate(db);
      if (current.task.questionId && validQuestion(db, current.task, current.item.meaning)) {
        return taskToView(db, current.task);
      }
      const excluded = db
        .select({ id: reviewTasks.questionId })
        .from(reviewTasks)
        .where(
          and(
            eq(reviewTasks.sessionId, current.task.sessionId),
            eq(reviewTasks.learningItemId, current.task.learningItemId),
            isNotNull(reviewTasks.questionId),
          ),
        )
        .all()
        .map((row) => row.id!);
      const type: QuestionKind =
        current.task.taskType === 'learn'
          ? 'understanding'
          : (current.task.taskType as QuestionKind);
      const question = await acquireWithGenerate(
        db,
        deps,
        current.task.learningItemId,
        type,
        now,
        excluded,
      );
      if (!question) throw appError('AI_PROVIDER_ERROR', '题目暂时无法生成，请稍后重试');
      const bound = db.transaction((tx) => {
        const latest = validate(tx);
        if (
          latest.item.target !== current.item.target ||
          latest.item.meaning !== current.item.meaning
        ) {
          // 编辑事务已退休旧库存；这里清掉 AI 等待期间迟到的旧题，避免下次误取。
          invalidateQuestions(tx, latest.item.id, now.toISOString());
          return null;
        }
        if (latest.task.questionId && validQuestion(tx, latest.task, latest.item.meaning)) {
          return taskToView(tx, latest.task);
        }
        const freshQuestion = tx
          .select()
          .from(questions)
          .where(eq(questions.id, question.id))
          .get();
        if (
          !freshQuestion ||
          freshQuestion.learningItemId !== latest.item.id ||
          freshQuestion.type !== type ||
          freshQuestion.meaningSnapshot !== latest.item.meaning ||
          (freshQuestion.status !== 'fresh' && freshQuestion.status !== 'active')
        ) {
          throw appError('CONFLICT', '题目已失效，请重试');
        }
        tx.update(reviewTasks)
          .set({ questionId: question.id })
          .where(
            and(
              eq(reviewTasks.id, taskId),
              isNull(reviewTasks.completedAt),
              isNull(reviewTasks.canceledAt),
            ),
          )
          .run();
        return taskToView(tx, { ...latest.task, questionId: question.id });
      });
      if (!bound) throw appError('CONFLICT', '学习项已修改，请重新准备题目');
      return bound;
    });
  } catch (err) {
    if (err instanceof JobLockTimeoutError)
      throw appError('CONFLICT', '题目正在准备中，请稍后重试');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /api/today/tasks/:id/answer
// ---------------------------------------------------------------------------

function reinforcementQuotaLeft(exec: DbExecutor, sessionId: string, itemId: string): number {
  const rows = exec
    .select()
    .from(reviewTasks)
    .where(
      and(
        eq(reviewTasks.sessionId, sessionId),
        eq(reviewTasks.learningItemId, itemId),
        eq(reviewTasks.origin, 'reinforcement'),
        isNull(reviewTasks.canceledAt),
      ),
    )
    .all();
  return Math.max(0, MAX_REINFORCEMENT_PER_ITEM_PER_SESSION - rows.length);
}

/**
 * 补强插入位置（TECHNICAL_DESIGN §7.2）：
 * max(当前任务 sort_key+3, 剩余队列后 30% 边界任务 sort_key) + 0.5
 */
function reinforcementSortKey(exec: DbExecutor, current: TaskRow): number {
  const pending = exec
    .select()
    .from(reviewTasks)
    .where(
      and(
        eq(reviewTasks.sessionId, current.sessionId),
        isNull(reviewTasks.completedAt),
        isNull(reviewTasks.canceledAt),
        gt(reviewTasks.sortKey, current.sortKey),
      ),
    )
    .orderBy(asc(reviewTasks.sortKey))
    .all();
  let boundary: number | null = null;
  if (pending.length > 0) {
    const idx = Math.min(
      pending.length - 1,
      Math.ceil(pending.length * (1 - REINFORCEMENT_TAIL_RATIO)),
    );
    boundary = pending[idx]!.sortKey;
  }
  const base = current.sortKey + REINFORCEMENT_MIN_GAP;
  return Math.max(base, boundary ?? base) + 0.5;
}

/** 表达题 attempt.correction_json → CorrectionView（幂等回放用） */
function parseCorrectionView(json: string | null): CorrectionView | null {
  if (!json) return null;
  try {
    const c = JSON.parse(json) as {
      segments?: CorrectionView['segments'];
      corrected?: string;
      better?: string | null;
      betterVersionKind?: string | null;
    };
    if (!Array.isArray(c.segments) || typeof c.corrected !== 'string') return null;
    return {
      segments: c.segments,
      correctedSentence: c.corrected,
      betterVersion: typeof c.better === 'string' ? c.better : null,
      betterVersionKind:
        c.betterVersionKind === 'polish' || c.betterVersionKind === 'rewrite'
          ? c.betterVersionKind
          : null,
    };
  } catch {
    return null;
  }
}

/** 幂等回放：已结算任务返回首次结算结果摘要（字段与首次结算完全一致） */
function replayAnswer(exec: DbExecutor, task: TaskRow): AnswerResponse {
  const attempt = exec
    .select()
    .from(attempts)
    .where(eq(attempts.reviewTaskId, task.id))
    .orderBy(asc(attempts.createdAt))
    .get();
  const session = exec
    .select()
    .from(reviewSessions)
    .where(eq(reviewSessions.id, task.sessionId))
    .get();
  const question = task.questionId
    ? (exec.select().from(questions).where(eq(questions.id, task.questionId)).get() ?? null)
    : null;
  const isCloze = question?.type === 'cloze';
  const isProduction = question?.type === 'production';
  const stored = attempt?.result;
  const result: AnswerResponse['result'] =
    stored === 'pass' || stored === 'basic_pass' ? stored : 'fail';
  const reveal = question && isCloze ? clozeReveal(question) : null;
  // 主动不会：feedback='gave_up'（无提交答案），表达题从绑定题目 payload 重建参考句揭示
  const gaveUp = attempt?.feedback === 'gave_up';
  const production = gaveUp && question && isProduction ? productionReveal(question) : null;
  // 表达题：回放首次批改 correction 与首次 personalExampleSaved（post 快照 exampleId）
  const correction = isProduction ? parseCorrectionView(attempt?.correctionJson ?? null) : null;
  const post = parseSnapshot(attempt?.postStateJson ?? null);
  return {
    result,
    outcomeSource: (attempt?.outcomeSource as AnswerResponse['outcomeSource']) ?? null,
    correct: result !== 'fail',
    gaveUp,
    selectedOptionId: attempt?.selectedOptionId ?? null,
    submittedAnswerText: attempt?.answerText ?? null,
    referenceAnswer: production?.referenceAnswer ?? null,
    answerNote: production?.answerNote ?? null,
    alreadyCompleted: true,
    explanation: attempt?.explanation ?? null,
    correctOptionId: question && !isCloze && !isProduction ? question.correctOptionId : null,
    completeSentence: reveal?.completeSentence ?? null,
    acceptedAnswer: reveal?.acceptedAnswer ?? null,
    correction,
    personalExampleSaved: isProduction ? Boolean(post?.personalExampleId) : false,
    reinforcementAdded: false,
    progress: session ? progressOf(exec, session.id) : { completed: 0, total: 0 },
    completed: session && session.completedAt !== null ? buildSummary(exec, session) : null,
  };
}

/**
 * 断连作废（2026-10-05 造句批改中取消）：isDisconnected 由路由注入（读
 * request.raw.socket.destroyed；不能用 raw.destroyed——body 读完即误置）。语义——
 * - 真断开（用户点「取消」掐断 fetch / 关页）：结算事务开启前检测到 → 本次作答零写入作废
 *   （无 attempt / 无 FSRS 推进 / 无统计），客户端保留输入可改写重交；
 * - 后台冻结（iOS 切后台）：连接未断，isDisconnected() 恒 false → 照常结算，
 *   与前端 visibilitychange 回前台刷新的承诺不冲突；
 * - 罕见竞态（结算事务已开才断）：检查在事务前，落库结果保留，取消无效，
 *   刷新后由幂等回放显示已批结果。
 * 仅 production 需要：批改有数秒 AI 等待窗口；recall/选择/填空即时结算无窗口。
 */
export async function answerTodayTask(
  db: AppDatabase,
  deps: TodayDeps,
  timezone: string,
  now: Date,
  taskId: string,
  body: AnswerRequest,
  settlementNow: () => Date = () => now,
  isDisconnected: () => boolean = () => false,
): Promise<AnswerResponse> {
  const task = db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get();
  if (!task) throw appError('NOT_FOUND', '任务不存在');
  if (task.canceledAt !== null) throw appError('CONFLICT', '该任务已撤销');

  const session = requireCurrentSession(db, task.sessionId, timezone, now);
  // 本地日校验必须先于幂等回放，旧标签页不能重放过期 Session。
  if (task.completedAt !== null) return replayAnswer(db, task);
  if (session.completedAt !== null) throw appError('CONFLICT', '会话已完成');

  const question = task.questionId
    ? (db.select().from(questions).where(eq(questions.id, task.questionId)).get() ?? null)
    : null;
  // Recall 判定契约（understanding 复习与 learn 新学"初见即回忆"共用，判定完全一致）
  const isRecallTask = task.taskType === 'understanding' || task.taskType === 'learn';
  // 未绑题（V2 懒绑定）仅放行 recall 三档自评 / giveUp：判定不依赖题目（2026-10-03 起
  // 理解题卡不消费绑定题，可不 prepare 直接作答）；选项/填空/表达提交仍必须有绑定题
  const recallWithoutQuestion =
    question === null && isRecallTask && (body.recall !== undefined || body.giveUp === true);
  if (!question && !recallWithoutQuestion) {
    throw appError('CONFLICT', '该任务没有可用题目');
  }
  if (question && question.status !== 'fresh' && question.status !== 'active') {
    throw appError('CONFLICT', '题目已失效，请刷新今日学习');
  }

  const isCloze = question?.type === 'cloze';
  const isProduction = question?.type === 'production';
  // 主动不会（PRODUCT §7.6）：独立的作答动作，与任何作答内容互斥（服务层兜底，路由层 Zod 已拦截）
  const giveUp = body.giveUp === true;
  if (giveUp) {
    if (
      body.selectedOptionId !== undefined ||
      body.answerText !== undefined ||
      body.recall !== undefined ||
      body.hintUsed !== undefined
    ) {
      throw appError('VALIDATION_ERROR', 'giveUp 与作答内容互斥，不能同时提交');
    }
  } else {
    if (isCloze && !body.answerText) {
      throw appError('VALIDATION_ERROR', '填空题必须提交 answerText');
    }
    if (isProduction && !body.answerText) {
      throw appError('VALIDATION_ERROR', '表达题必须提交 answerText');
    }
    if (!isCloze && !isProduction && !isRecallTask && !body.selectedOptionId) {
      throw appError('VALIDATION_ERROR', '选择题必须提交 selectedOptionId');
    }
    if (isRecallTask && !body.recall && !body.selectedOptionId) {
      throw appError('VALIDATION_ERROR', 'Recall 题必须提交 recall 或 selectedOptionId');
    }
  }

  // ---- 事务外：评估（giveUp 不调用任何判定/批改；表达题走 check_production 实时批改）----
  let production: ProductionEvaluation | null = null;
  let outcome: EvaluateOutcome;
  if (giveUp) {
    // 主动不会：直接按 fail 结算，零生产/填空/选择判定调用（TECHNICAL_DESIGN §7.5）
    outcome = { correct: false };
  } else if (question && isProduction) {
    try {
      production = await deps.evaluateProduction(db, question, body.answerText!);
    } catch (err) {
      // 批改失败：不写任何数据，保留用户输入由前端重试（AI_RULES §14）
      if (err instanceof AppError && err.code !== 'AI_PROVIDER_ERROR') throw err;
      throw appError('AI_PROVIDER_ERROR', '批改失败，请重试');
    }
    outcome = { correct: production.result !== 'fail' };
  } else if (question && isCloze) {
    outcome = await deps.evaluateCloze(db, question, body.answerText!);
  } else if (isRecallTask && body.recall) {
    // Recall Card 三档自评（2026-10-03）：recalled/easy 为通过（pass），forgot 未通过；
    // understanding 与 learn（新词初见即回忆）共用，cloze 误传 recall 不生效，落入 cloze 路径
    outcome = { correct: body.recall !== 'forgot' };
  } else if (question) {
    outcome = deps.evaluateChoice(question, body.selectedOptionId!);
  } else {
    // 未绑题只允许 recall/giveUp（recallWithoutQuestion 已拦截其余提交），此处不可达
    throw appError('INTERNAL', '未绑定题目的作答缺少判定依据');
  }
  const correct = outcome.correct === true;
  const viewedSource = body.viewedSource === true;
  // Recall 判定（understanding 复习与 learn 新学共用，三档自评 2026-10-03）：
  // recalled=良好 / easy=简单（均 pass，靠 outcomeSource 区分）/ forgot=重来（fail）；
  // hint 选择→对=assisted(basic_pass)/错=forgot(fail)；
  // 查看原句不再降档（Recall 卡默认展示 source_example）。cloze 旧语义不变。
  // 主动不会按 fail 结算：理解题证据为 forgot（PRODUCT §6.2），其余题型无证据档。
  let outcomeSource: 'recalled' | 'assisted' | 'forgot' | 'easy' | null = null;
  let result: AnswerResponse['result'];
  if (giveUp) {
    result = 'fail';
    outcomeSource = isRecallTask ? 'forgot' : null;
  } else if (isProduction) {
    result = production!.result;
  } else if (isRecallTask) {
    if (body.recall) {
      outcomeSource = body.recall;
      result = correct ? 'pass' : 'fail';
    } else {
      outcomeSource = correct ? 'assisted' : 'forgot';
      result = correct ? 'basic_pass' : 'fail';
    }
  } else {
    result = correct ? (viewedSource ? 'basic_pass' : 'pass') : 'fail';
  }

  // ---- 事务外：补强题预取（仅复习选择题/填空题；表达题不强制当天重做，PRODUCT §7.6；
  // learn fail 不补强——reveal 已教学，方案 A）----
  const reinforceType: QuestionKind = task.taskType === 'cloze' ? 'cloze' : 'understanding';
  let reinforcementQuestion: QuestionRow | null = null;
  if (
    !isProduction &&
    task.taskType !== 'learn' &&
    result === 'fail' &&
    reinforcementQuotaLeft(db, task.sessionId, task.learningItemId) > 0
  ) {
    reinforcementQuestion = await acquireWithGenerate(
      db,
      deps,
      task.learningItemId,
      reinforceType,
      now,
      question ? [question.id] : undefined,
    );
  }

  const nowIso = now.toISOString();

  // 批改等待期间客户端已断连（取消）：作废本次作答，不进结算事务（零写入）。
  // 客户端已断，响应自然丢弃；错误仅用于服务端日志与测试断言。
  if (isProduction && isDisconnected()) {
    throw appError('CONFLICT', '已取消');
  }

  // ---- 同步事务：结算写库（AI 已全部完成，回调严格同步）----
  return db.transaction((tx) => {
    const fresh = tx.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get();
    if (!fresh) throw appError('NOT_FOUND', '任务不存在');
    requireCurrentSession(tx, fresh.sessionId, timezone, settlementNow());
    if (fresh.canceledAt !== null) throw appError('CONFLICT', '该任务已撤销');
    if (fresh.completedAt !== null) return replayAnswer(tx, fresh);
    if (question) {
      const freshQuestion = tx.select().from(questions).where(eq(questions.id, question.id)).get();
      if (
        fresh.questionId !== question.id ||
        !freshQuestion ||
        (freshQuestion.status !== 'fresh' && freshQuestion.status !== 'active')
      ) {
        throw appError('CONFLICT', '题目已失效，请刷新今日学习');
      }
    }

    const itemId = task.learningItemId;
    const pre = snapshotOf(tx, itemId);
    const reinforcementIds: string[] = [];
    // easy（三档「简单」）= pass + tooEasy（FSRS Easy 评分）；learn 首答与非 learn 复习共用映射
    const easyRecall = isRecallTask && body.recall === 'easy';
    const settleOutcome: ReviewOutcomeInput = easyRecall
      ? { kind: 'pass', tooEasy: true }
      : { kind: result };

    if (task.taskType === 'learn') {
      // Learn Recall（方案 A）：三档路径都完成新学——首答判定即首次 Rating 建 U 卡 + P 激活；
      // forgot/assisted 的揭示即教学时刻，明日以短间隔回归；easy 首答即 Easy 评分。
      // 无论对错都已开始学 → queue_state='started' 且当日额度 +1。
      writeDimState(
        tx,
        itemId,
        'understanding',
        deps.initialUnderstandingAfterLearn(settleOutcome, now),
        nowIso,
      );
      const item = tx.select().from(learningItems).where(eq(learningItems.id, itemId)).get()!;
      if (effectiveProductionEnabled(item)) {
        writeDimState(tx, itemId, 'production', deps.initialProductionActivation(now), nowIso);
      }
      tx.update(learningItems)
        .set({ queueState: 'started', updatedAt: nowIso })
        .where(eq(learningItems.id, itemId))
        .run();
      bumpDailyStats(tx, session.sessionDate, { formal: 1, newItems: 1 }, nowIso);
      tx.update(reviewSessions)
        .set({ newItemsStarted: session.newItemsStarted + 1 })
        .where(eq(reviewSessions.id, session.id))
        .run();
    } else {
      // 普通复习：review.advanceReviewState（FSRS）推进该维度（含 streak 写回与 mastered 判定）。
      // easy（三档「简单」）：结算等同 pass 计入通过，评分映射为 FSRS Easy（间隔更长）。
      deps.advance(tx, itemId, task.dimension as Dimension, settleOutcome, now);
      bumpDailyStats(
        tx,
        session.sessionDate,
        {
          formal: 1,
          // 表达题计数（仅 today 正式模式；practice 不走此路径）
          productionAttempts: isProduction ? 1 : 0,
          productionPass: isProduction && result === 'pass' ? 1 : 0,
        },
        nowIso,
      );
    }

    // Read 补强任务完成即清旗（无论对错；PRODUCT §8.2 旗只在此清，答对 Read check 不清）
    if (fresh.origin === 'read_reinforcement') {
      tx.update(learningItems)
        .set({ needsReinforcement: 0, updatedAt: nowIso })
        .where(eq(learningItems.id, itemId))
        .run();
    }

    // 补强任务插入（fail；题目已事务外预取；配额事务内复核；learn fail 不插——reveal 已教学）
    let reinforcementAdded = false;
    if (result === 'fail' && task.taskType !== 'learn' && reinforcementQuestion) {
      if (reinforcementQuotaLeft(tx, task.sessionId, task.learningItemId) > 0) {
        const reinforcementId = randomUUID();
        tx.insert(reviewTasks)
          .values({
            id: reinforcementId,
            sessionId: task.sessionId,
            learningItemId: task.learningItemId,
            dimension: task.dimension,
            questionId: reinforcementQuestion.id,
            taskType: reinforceType,
            origin: 'reinforcement',
            sortKey: reinforcementSortKey(tx, fresh),
            deferCount: 0,
            completedAt: null,
            canceledAt: null,
            createdAt: nowIso,
          })
          .run();
        reinforcementIds.push(reinforcementId);
        reinforcementAdded = true;
      }
    }

    // post 快照（两维 review 状态 + item.status + 新增补强任务 id）
    const post = snapshotOf(tx, task.learningItemId);
    post.reinforcementTaskIds = reinforcementIds;

    // 表达题：按候选明确选择的 corrected/polish 句沉淀 Personal Example（PRODUCT §3.2/§7.5），
    // post 快照记录本次写入的 exampleId（坏题撤销依据）与被替换例句行（普通撤销恢复）
    let personalSaved: PersonalExampleSaveResult = SKIP_PERSONAL;
    if (isProduction && production) {
      personalSaved = maybeSavePersonalExample(
        tx,
        task.learningItemId,
        {
          result: production.result,
          eligible: production.candidate.eligible,
          source: production.candidate.source,
          qualityScore: production.candidate.qualityScore,
          correctedSentence: production.correctedSentence,
          originalText: body.answerText!,
          betterVersion: production.betterVersion,
          betterVersionKind: production.betterVersionKind,
        },
        now,
      );
      if (personalSaved.exampleId) {
        post.personalExampleId = personalSaved.exampleId;
        post.personalExampleText =
          tx
            .select({ text: learningExamples.text })
            .from(learningExamples)
            .where(eq(learningExamples.id, personalSaved.exampleId))
            .get()?.text ?? null;
      }
      if (personalSaved.replacedExampleSnapshot) {
        post.replacedPersonalExample = personalSaved.replacedExampleSnapshot;
      }
    }

    const reveal = question && isCloze ? clozeReveal(question) : null;
    // 主动不会的表达题揭示：参考句/用法说明取自绑定题目 payload（仅作答后返回）
    const giveUpProductionReveal =
      giveUp && question && isProduction ? productionReveal(question) : null;
    const explanation = question
      ? giveUp
        ? // 主动不会：表达题无批改说明（揭示走 payload 参考句/用法说明）；选择/填空揭示解释
          isProduction
          ? null
          : revealExplanation(question, false)
        : isProduction
          ? production!.explanation
          : revealExplanation(question, correct)
      : null; // 未绑题的 recall 自评/giveUp 无题面解释可揭示
    const attemptId = randomUUID();
    tx.insert(attempts)
      .values({
        id: attemptId,
        reviewTaskId: task.id,
        learningItemId: task.learningItemId,
        // 未绑题的 recall 作答允许 question_id=null（列本就可空，schema set null）
        questionId: question?.id ?? null,
        mode: 'today',
        answerText: body.answerText ?? null,
        // recall 直判时归一化丢弃并存选项，避免统计层误读
        selectedOptionId: isRecallTask && body.recall ? null : (body.selectedOptionId ?? null),
        result,
        viewedSource: viewedSource ? 1 : 0,
        // 主动不会持久化为 gave_up（与事后人工反馈互斥，DATABASE.md §8）
        feedback: giveUp ? 'gave_up' : null,
        outcomeSource,
        correctionJson: production
          ? JSON.stringify({
              segments: production.segments,
              corrected: production.correctedSentence,
              better: production.betterVersion,
              betterVersionKind: production.betterVersionKind,
              personalExampleSource: production.candidate.source,
            })
          : null,
        explanation,
        betterVersion: production?.betterVersion ?? null,
        // 表达题记录 check_production 实际 Prompt 元数据（PRODUCT 可追溯实体要求）；
        // 选择/填空题的 AI 兜底由 questions 模块内部处理，此处置空
        aiPromptKey: production?.promptMeta.key ?? null,
        aiPromptVersion: production?.promptMeta.version ?? null,
        aiPromptHash: production?.promptMeta.hash ?? null,
        aiModel: production?.promptMeta.model ?? null,
        preStateJson: JSON.stringify(pre),
        postStateJson: JSON.stringify(post),
        createdAt: nowIso,
        voidedAt: null,
      })
      .run();

    // 造句历史裁剪：保留该 item 最近 10 条 production attempts（PRODUCT §7.5）；
    // 被裁剪行快照在裁剪后补写进 post 快照（DATABASE §8：撤销期间保留恢复快照）
    if (isProduction) {
      const pruned = trimProductionHistory(tx, task.learningItemId);
      if (pruned.length > 0) {
        post.prunedProductionAttempts = pruned;
        tx.update(attempts)
          .set({ postStateJson: JSON.stringify(post) })
          .where(eq(attempts.id, attemptId))
          .run();
      }
    }

    tx.update(reviewTasks).set({ completedAt: nowIso }).where(eq(reviewTasks.id, task.id)).run();

    // 完成检测：无非 canceled 未完成任务 → session 完成并构建摘要
    let completedSummary: TodaySummary | null = null;
    const remaining = tx
      .select()
      .from(reviewTasks)
      .where(
        and(
          eq(reviewTasks.sessionId, session.id),
          isNull(reviewTasks.completedAt),
          isNull(reviewTasks.canceledAt),
        ),
      )
      .all();
    if (remaining.length === 0) {
      tx.update(reviewSessions)
        .set({ completedAt: nowIso })
        .where(eq(reviewSessions.id, session.id))
        .run();
      completedSummary = buildSummary(tx, { ...session, completedAt: nowIso });
    }

    return {
      result,
      outcomeSource,
      correct,
      gaveUp: giveUp,
      // 真实作答回传提交内容（与 attempt 落库一致：recall 直判的选项已归一丢弃）；giveUp 为 null
      selectedOptionId: isRecallTask && body.recall ? null : (body.selectedOptionId ?? null),
      submittedAnswerText: body.answerText ?? null,
      referenceAnswer: giveUpProductionReveal?.referenceAnswer ?? null,
      answerNote: giveUpProductionReveal?.answerNote ?? null,
      explanation,
      correctOptionId: question && !isCloze && !isProduction ? question.correctOptionId : null,
      completeSentence: reveal?.completeSentence ?? null,
      acceptedAnswer: reveal?.acceptedAnswer ?? null,
      correction: production
        ? {
            segments: production.segments,
            correctedSentence: production.correctedSentence,
            betterVersion: production.betterVersion,
            betterVersionKind: production.betterVersionKind,
          }
        : null,
      personalExampleSaved: personalSaved.saved,
      reinforcementAdded,
      progress: progressOf(tx, session.id),
      completed: completedSummary,
    };
  });
}

// ---------------------------------------------------------------------------
// POST /api/today/tasks/:id/later
// ---------------------------------------------------------------------------

const DEFER_SORT_OFFSET = 1000;

function requireCurrentSession(
  exec: DbExecutor,
  sessionId: string,
  timezone: string,
  now: Date,
): SessionRow {
  const session = exec.select().from(reviewSessions).where(eq(reviewSessions.id, sessionId)).get();
  if (!session) throw appError('INTERNAL', '会话不存在');
  if (session.sessionDate !== localDateString(now, timezone)) {
    throw appError('CONFLICT', '会话已过期，请刷新今日学习');
  }
  return session;
}

export function deferTodayTask(
  db: AppDatabase,
  taskId: string,
  timezone: string,
  now: Date,
): LaterResponse {
  return db.transaction((tx) => {
    const task = requireTask(tx, taskId);
    requireCurrentSession(tx, task.sessionId, timezone, now);
    if (task.completedAt !== null || task.canceledAt !== null) {
      throw appError('CONFLICT', '任务已完成或已撤销，无法稍后再做');
    }
    const pending = tx
      .select()
      .from(reviewTasks)
      .where(
        and(
          eq(reviewTasks.sessionId, task.sessionId),
          isNull(reviewTasks.completedAt),
          isNull(reviewTasks.canceledAt),
        ),
      )
      .all();
    const maxSort = pending.reduce((m, t) => Math.max(m, t.sortKey), 0);
    tx.update(reviewTasks)
      .set({ deferCount: task.deferCount + 1, sortKey: maxSort + DEFER_SORT_OFFSET })
      .where(eq(reviewTasks.id, taskId))
      .run();
    // later 不写 attempt、不改变学习状态（TECHNICAL_DESIGN §7.3）
    return { ok: true as const, progress: progressOf(tx, task.sessionId) };
  });
}

// ---------------------------------------------------------------------------
// POST /api/today/tasks/:id/bad-question
// ---------------------------------------------------------------------------

export function reportBadQuestion(
  db: AppDatabase,
  taskId: string,
  now: Date,
  timezone: string,
): BadQuestionResponse {
  const nowIso = now.toISOString();
  return db.transaction((tx) => {
    const task = requireTask(tx, taskId);
    const session = requireCurrentSession(tx, task.sessionId, timezone, now);
    if (task.canceledAt !== null) {
      // 幂等：已撤销（含重复 👎）直接返回进度
      return { ok: true as const, progress: progressOf(tx, task.sessionId) };
    }
    const attempt = tx
      .select()
      .from(attempts)
      .where(eq(attempts.reviewTaskId, taskId))
      .orderBy(desc(attempts.createdAt))
      .get();
    if (!attempt || task.completedAt === null) {
      throw appError('CONFLICT', '该任务尚未作答，无法标记坏题');
    }
    if (attempt.result === 'void') {
      return { ok: true as const, progress: progressOf(tx, task.sessionId) };
    }

    // 前置校验：该 attempt 之后同 item+维度存在非 void 作答 → 拒绝撤销
    const laterAttempts = tx
      .select({ id: attempts.id })
      .from(attempts)
      .innerJoin(reviewTasks, eq(reviewTasks.id, attempts.reviewTaskId))
      .where(
        and(
          eq(reviewTasks.learningItemId, task.learningItemId),
          eq(reviewTasks.dimension, task.dimension),
          ne(attempts.result, 'void'),
          ne(attempts.id, attempt.id),
          gte(attempts.createdAt, attempt.createdAt),
        ),
      )
      .all();
    if (laterAttempts.length > 0) {
      throw appError('CONFLICT', '已有后续作答，无法撤销');
    }

    // 1) 题目 → bad_question，立即退出练习池
    if (task.questionId) {
      tx.update(questions)
        .set({ status: 'bad_question' })
        .where(eq(questions.id, task.questionId))
        .run();
    }

    // 2) 恢复 pre 快照：两维 review 状态、item.status、queue_state
    const pre = parseSnapshot(attempt.preStateJson);
    if (pre) restoreSnapshot(tx, task.learningItemId, pre, nowIso);

    // 3) 取消本次结算新增的补强任务
    const post = parseSnapshot(attempt.postStateJson);
    for (const rid of post?.reinforcementTaskIds ?? []) {
      tx.update(reviewTasks)
        .set({ canceledAt: nowIso })
        .where(and(eq(reviewTasks.id, rid), isNull(reviewTasks.canceledAt)))
        .run();
    }

    // 3A) 撤销本次结算写入的 Personal Example（已被用户 pinned 的除外，PRODUCT §3.2）
    if (post?.personalExampleId) {
      const example = tx
        .select()
        .from(learningExamples)
        .where(eq(learningExamples.id, post.personalExampleId))
        .get();
      if (example && example.pinned === 0) {
        tx.delete(learningExamples).where(eq(learningExamples.id, example.id)).run();
      }
    }

    // 4) daily_stats 回减 + learn 会话计数回滚
    const delta: StatsDelta = { formal: -1 };
    if (task.taskType === 'learn') delta.newItems = -1;
    if (task.taskType === 'production') {
      delta.productionAttempts = -1;
      if (attempt.result === 'pass') delta.productionPass = -1;
    }
    bumpDailyStats(tx, session.sessionDate, delta, nowIso);
    if (task.taskType === 'learn') {
      tx.update(reviewSessions)
        .set({ newItemsStarted: Math.max(0, session.newItemsStarted - 1) })
        .where(eq(reviewSessions.id, session.id))
        .run();
    }

    // 5) attempt void + 任务取消
    tx.update(attempts)
      .set({ result: 'void', voidedAt: nowIso, feedback: null })
      .where(eq(attempts.id, attempt.id))
      .run();
    tx.update(reviewTasks).set({ canceledAt: nowIso }).where(eq(reviewTasks.id, task.id)).run();

    return { ok: true as const, progress: progressOf(tx, task.sessionId) };
  });
}

// ---------------------------------------------------------------------------
// POST /api/today/tasks/:id/undo（普通撤销最近一次作答，TECHNICAL_DESIGN §7.5）
// ---------------------------------------------------------------------------

/** 识别本次实际插入的文本；旧快照按当时插入/替换两条路径各自的行为回退。 */
function insertedExampleTextOf(
  attempt: AttemptRowSnapshot,
  post: StateSnapshot | null,
): string | null {
  if (typeof post?.personalExampleText === 'string') return post.personalExampleText;
  if (!attempt.correctionJson) return null;
  try {
    const parsed = JSON.parse(attempt.correctionJson) as {
      corrected?: unknown;
      better?: unknown;
    };
    if (post?.replacedPersonalExample) {
      // Oct 3 的历史替换路径保存 corrected。
      return typeof parsed.corrected === 'string' ? parsed.corrected : null;
    }
    // Oct 3 的历史插入路径优先保存 better，缺省 corrected。
    return typeof parsed.better === 'string'
      ? parsed.better
      : typeof parsed.corrected === 'string'
        ? parsed.corrected
        : null;
  } catch {
    return null;
  }
}

/**
 * 普通撤销：只回滚当天 Session 最近一次未撤销的正式作答（PRODUCT §5.1）。
 * 与坏题撤销不同：不改题目状态。重答立即回同词；只有造句换题，其余复用原题。
 * 新造句题在事务外预取；取不到时抛可重试错误且不改变任何数据。
 */
export async function undoTodayTask(
  db: AppDatabase,
  deps: TodayDeps,
  timezone: string,
  now: Date,
  taskId: string,
): Promise<UndoResponse> {
  const today = localDateString(now, timezone);
  const task = db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get();
  if (!task) throw appError('NOT_FOUND', '任务不存在');
  const session = db
    .select()
    .from(reviewSessions)
    .where(eq(reviewSessions.id, task.sessionId))
    .get();
  if (!session) throw appError('INTERNAL', '会话不存在');
  if (session.sessionDate !== today) throw appError('CONFLICT', '只能撤销今天的作答');

  // 预取前的只读快检（事务内还会复核）：明显失效的请求直接拒绝，
  // 避免为过期撤销白白消耗题目库存（取题会写 use_count/last_used_at）
  if (task.canceledAt !== null) throw appError('CONFLICT', '该任务已撤销');
  if (task.completedAt === null) throw appError('CONFLICT', '该任务尚未作答，无法撤销');
  const latestNow = latestSessionAttempt(db, task.sessionId);
  if (!latestNow || latestNow.attempt.reviewTaskId !== taskId) {
    throw appError('CONFLICT', '已有更新的作答，无法撤销该任务');
  }

  // 只有造句换题；Recall/Learn 及遗留非造句题复用原绑定，不消耗题库或调用 AI。
  const replacement =
    task.taskType === 'production'
      ? await acquireWithGenerate(db, deps, task.learningItemId, 'production', now, [
          task.questionId ?? '',
        ])
      : null;
  if (task.taskType === 'production' && !replacement) {
    // 没有可用新题：保持原作答与会话不变，提示重试（PRODUCT §5.1）
    throw appError('CONFLICT', '暂时没有可用的新题，请稍后重试');
  }

  const nowIso = now.toISOString();
  return db.transaction((tx) => {
    // ---- 事务内复核（顺序：会话日期 → 精确最近作答 → 任务完成 → 依赖数据安全 → 替代题）----
    const freshSession = tx
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.id, task.sessionId))
      .get();
    if (!freshSession) throw appError('INTERNAL', '会话不存在');
    if (freshSession.sessionDate !== today) throw appError('CONFLICT', '只能撤销今天的作答');

    // 精确最近作答：目标任务的 attempt 必须仍是本会话最近一次非 void 作答
    // （过期任务/重复撤销在此拒绝，不会误伤更早的作答）
    const latest = latestSessionAttempt(tx, task.sessionId);
    if (!latest || latest.attempt.reviewTaskId !== taskId) {
      throw appError('CONFLICT', '已有更新的作答，无法撤销该任务');
    }
    const attempt = latest.attempt;

    const freshTask = tx.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get();
    if (!freshTask) throw appError('NOT_FOUND', '任务不存在');
    if (freshTask.canceledAt !== null) throw appError('CONFLICT', '该任务已撤销');
    if (freshTask.completedAt === null) throw appError('CONFLICT', '该任务尚未作答，无法撤销');

    // 依赖数据安全：快照缺失 / 新例句已被用户固定或编辑 → 拒绝撤销以保护用户数据
    const pre = parseSnapshot(attempt.preStateJson);
    if (!pre) throw appError('CONFLICT', '该作答缺少状态快照，无法撤销');
    const post = parseSnapshot(attempt.postStateJson);
    const savedExampleId = post?.personalExampleId;
    if (savedExampleId) {
      const saved = tx
        .select()
        .from(learningExamples)
        .where(eq(learningExamples.id, savedExampleId))
        .get();
      if (saved) {
        const insertedText = insertedExampleTextOf(attempt, post);
        const edited = insertedText !== null && saved.text !== insertedText;
        if (saved.pinned === 1 || edited) {
          throw appError('CONFLICT', '本次例句已被固定或修改，无法撤销');
        }
      }
    }
    // 替代题仍可用（并发下可能被占用或失效）
    if (replacement) {
      const replacementRow = tx
        .select()
        .from(questions)
        .where(eq(questions.id, replacement.id))
        .get();
      if (
        !replacementRow ||
        replacementRow.status === 'bad_question' ||
        replacementRow.status === 'retired'
      ) {
        throw appError('CONFLICT', '替代题目已不可用，请重试');
      }
    }

    // ---- 精确回滚（仅本次 attempt 的变动）----
    // 1) 恢复 pre 快照：两维 review 状态、item.status/queue_state、Read 补强旗
    restoreSnapshot(tx, task.learningItemId, pre, nowIso);

    // 2) 只取消本次结算记录的补强任务（已取消的跳过）
    for (const rid of post?.reinforcementTaskIds ?? []) {
      tx.update(reviewTasks)
        .set({ canceledAt: nowIso })
        .where(and(eq(reviewTasks.id, rid), isNull(reviewTasks.canceledAt)))
        .run();
    }

    // 3) 反向回减统计与新学额度（Learn：formal+new_items+会话计数；表达题：attempts/pass）
    const isLearn = task.taskType === 'learn';
    const delta: StatsDelta = { formal: -1 };
    if (isLearn) delta.newItems = -1;
    if (task.taskType === 'production') {
      delta.productionAttempts = -1;
      if (attempt.result === 'pass') delta.productionPass = -1;
    }
    bumpDailyStats(tx, freshSession.sessionDate, delta, nowIso);
    if (isLearn) {
      tx.update(reviewSessions)
        .set({ newItemsStarted: Math.max(0, freshSession.newItemsStarted - 1) })
        .where(eq(reviewSessions.id, task.sessionId))
        .run();
    }

    // 4) 恢复保留数据：删除本次新增例句、精确还原被替换例句与被裁剪表达历史
    if (savedExampleId) {
      tx.delete(learningExamples).where(eq(learningExamples.id, savedExampleId)).run();
    }
    const displaced = post?.replacedPersonalExample;
    if (displaced) {
      tx.delete(learningExamples).where(eq(learningExamples.id, displaced.id)).run();
      tx.insert(learningExamples).values(displaced).run();
    }
    for (const pruned of post?.prunedProductionAttempts ?? []) {
      tx.insert(attempts).values(pruned).run();
    }

    // 5) 作废该次 attempt + 取消旧任务
    tx.update(attempts)
      .set({ result: 'void', voidedAt: nowIso, feedback: null })
      .where(eq(attempts.id, attempt.id))
      .run();
    tx.update(reviewTasks).set({ canceledAt: nowIso }).where(eq(reviewTasks.id, task.id)).run();

    // 6) 新任务放到剩余待答队列之前，立即回同词；沿用 taskType/dimension/origin。
    //    配额槽位由替代题占用同一槽位（不额外消耗），read_reinforcement 沿用清旗语义
    const firstPendingSort = tx
      .select({ m: sql<number | null>`min(${reviewTasks.sortKey})` })
      .from(reviewTasks)
      .where(
        and(
          eq(reviewTasks.sessionId, task.sessionId),
          isNull(reviewTasks.completedAt),
          isNull(reviewTasks.canceledAt),
        ),
      )
      .get()?.m;
    tx.insert(reviewTasks)
      .values({
        id: randomUUID(),
        sessionId: task.sessionId,
        learningItemId: task.learningItemId,
        dimension: task.dimension,
        questionId: replacement?.id ?? freshTask.questionId,
        taskType: task.taskType,
        origin: task.origin,
        sortKey: firstPendingSort == null ? freshTask.sortKey : Number(firstPendingSort) - 1,
        deferCount: 0,
        completedAt: null,
        canceledAt: null,
        createdAt: nowIso,
      })
      .run();

    // 7) 重新激活已完成的会话
    tx.update(reviewSessions)
      .set({ completedAt: null })
      .where(eq(reviewSessions.id, task.sessionId))
      .run();

    return { ok: true as const, progress: progressOf(tx, task.sessionId) };
  });
}

// ---------------------------------------------------------------------------
// POST /api/today/tasks/:id/feedback
// ---------------------------------------------------------------------------

export function submitTaskFeedback(
  db: AppDatabase,
  deps: TodayDeps,
  timezone: string,
  taskId: string,
  feedback: 'guessed' | 'too_easy',
  now: Date,
): TaskFeedbackResponse {
  const nowIso = now.toISOString();
  return db.transaction((tx) => {
    const task = requireTask(tx, taskId);
    requireCurrentSession(tx, task.sessionId, timezone, now);
    if (task.taskType === 'learn') throw appError('CONFLICT', 'Learn 任务不支持反馈');
    // 蒙的/太简单只适用于选择题/填空题（PRODUCT §7.6：表达题不支持该反馈）
    if (task.taskType === 'production') {
      throw appError('VALIDATION_ERROR', '表达题不支持该反馈');
    }
    const attempt = tx
      .select()
      .from(attempts)
      .where(eq(attempts.reviewTaskId, taskId))
      .orderBy(desc(attempts.createdAt))
      .get();
    if (!attempt) throw appError('CONFLICT', '该任务尚未作答');
    if (attempt.result === 'void') throw appError('CONFLICT', '该作答已撤销');
    if (attempt.feedback !== null) throw appError('CONFLICT', '该任务已反馈过');

    const dim = task.dimension as Dimension;
    let adjusted: TaskFeedbackResponse['adjustedResult'];
    if (feedback === 'guessed') {
      // 其实蒙的：以 attempt.pre_state 为基准按 fail 重算（先恢复该维度快照，再 advance）
      const pre = parseSnapshot(attempt.preStateJson);
      restoreDimState(tx, task.learningItemId, dim, pre?.reviewStates[dim] ?? null, nowIso);
      deps.advance(tx, task.learningItemId, dim, { kind: 'fail' }, now);
      adjusted = 'fail';
    } else {
      // 太简单：以当前 post 状态 pass + tooEasy 重算；查看原句的结果上限 basic_pass
      const viewed = attempt.viewedSource === 1;
      deps.advance(
        tx,
        task.learningItemId,
        dim,
        viewed ? { kind: 'basic_pass' } : { kind: 'pass', tooEasy: true },
        now,
      );
      adjusted = viewed ? 'basic_pass' : 'pass';
    }

    // guessed 可能使刚判定的 mastered 失效（review.advance 只设置不回退，此处补偿）
    const itemId = task.learningItemId;
    if (feedback === 'guessed') {
      const states = tx
        .select()
        .from(reviewStates)
        .where(eq(reviewStates.learningItemId, itemId))
        .all();
      const u = states.find((s) => s.dimension === 'understanding');
      const p = states.find((s) => s.dimension === 'production');
      const item = tx.select().from(learningItems).where(eq(learningItems.id, itemId)).get();
      // 与 reconcileItemStatus 同语义（Task 3 顺手修）：缺行按未激活兜底、目标关闭只看 U——
      // 不得因 production 关闭且无 P 行而误降仍越过掌握线（S≥120）的 mastered
      const stillMastered =
        !!item &&
        isMastered(
          u ? rowToDim(u) : INACTIVE_SNAPSHOT,
          p ? rowToDim(p) : INACTIVE_SNAPSHOT,
          effectiveProductionEnabled(item),
        );
      if (!stillMastered && item?.status === 'mastered') {
        tx.update(learningItems)
          .set({ status: 'active', updatedAt: nowIso })
          .where(eq(learningItems.id, itemId))
          .run();
      }
    }

    // 更新 post 快照（保留补强任务 id 列表）
    const oldPost = parseSnapshot(attempt.postStateJson);
    const newPost = snapshotOf(tx, itemId);
    newPost.reinforcementTaskIds = oldPost?.reinforcementTaskIds ?? [];
    tx.update(attempts)
      .set({
        feedback,
        result: adjusted,
        // too_easy 调整为 pass 时补写 easy：历史回放（ratingOfAttempt）按 outcomeSource 评
        // Easy 而非 Good；上限 basic_pass（回放恒 Hard）不改写，保留作答时的原值
        outcomeSource: adjusted === 'pass' ? 'easy' : attempt.outcomeSource,
        postStateJson: JSON.stringify(newPost),
      })
      .where(eq(attempts.id, attempt.id))
      .run();

    return { ok: true as const, adjustedResult: adjusted };
  });
}
