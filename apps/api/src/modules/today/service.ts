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
  productionQuestionTypeFor,
  type DbExecutor,
  type DbTx,
  type ProductionEvaluation,
  type QuestionPoolType,
  type QuestionRow,
} from '../questions/service.js';
import {
  maybeSavePersonalExample,
  trimProductionHistory,
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

/** 单维度复习状态快照（review_states 行的业务投影） */
export interface DimSnapshot {
  level: number;
  stable: boolean;
  nextReviewAt: string | null;
  lastReviewAt: string | null;
  correctStreak: number;
  wrongStreak: number;
}

/** attempt 的 pre/post 状态快照（坏题撤销依据，DATABASE.md §8） */
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
}

export type AdvanceKind = 'pass' | 'basic_pass' | 'fail';

/** maybeSavePersonalExample 的"未沉淀"结果（非表达题路径共用） */
const SKIP_PERSONAL: PersonalExampleSaveResult = {
  saved: false,
  replacedExampleId: null,
  exampleId: null,
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
  initialUnderstandingAfterLearn(now: Date): DimSnapshot;
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
    level: typeof r.level === 'number' ? r.level : 0,
    stable: r.stable === true || r.stable === 1,
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
    initialUnderstandingAfterLearn: (now) => toDimSnapshot(initialUFn(now)),
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
    level: row.level,
    stable: row.stable === 1,
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

/** 坏题撤销 / 反馈重算前：把单个维度恢复为快照值（快照为 null 则删除该行） */
function restoreDimState(
  exec: DbExecutor,
  itemId: string,
  dim: Dimension,
  snap: (DimSnapshot & { id: string }) | null,
  nowIso: string,
): void {
  exec
    .delete(reviewStates)
    .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dim)))
    .run();
  if (snap) {
    exec
      .insert(reviewStates)
      .values({
        id: snap.id,
        learningItemId: itemId,
        dimension: dim,
        level: snap.level,
        stable: snap.stable ? 1 : 0,
        nextReviewAt: snap.nextReviewAt,
        lastReviewAt: snap.lastReviewAt,
        correctStreak: snap.correctStreak,
        wrongStreak: snap.wrongStreak,
        updatedAt: nowIso,
      })
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
    level: next.level,
    stable: next.stable ? 1 : 0,
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
    exec
      .delete(reviewStates)
      .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dim)))
      .run();
    const pre = snap.reviewStates[dim];
    if (pre) {
      exec
        .insert(reviewStates)
        .values({
          id: pre.id,
          learningItemId: itemId,
          dimension: dim,
          level: pre.level,
          stable: pre.stable ? 1 : 0,
          nextReviewAt: pre.nextReviewAt,
          lastReviewAt: pre.lastReviewAt,
          correctStreak: pre.correctStreak,
          wrongStreak: pre.wrongStreak,
          updatedAt: nowIso,
        })
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

  const question = task.questionId
    ? (exec.select().from(questions).where(eq(questions.id, task.questionId)).get() ?? null)
    : null;
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
  const [{ dueItems }] = db
    .select({ dueItems: sql<number>`count(*)` })
    .from(reviewStates)
    .innerJoin(learningItems, eq(learningItems.id, reviewStates.learningItemId))
    .where(
      and(
        eq(learningItems.status, 'active'),
        eq(learningItems.queueState, 'started'),
        eq(reviewStates.stable, 0),
        isNotNull(reviewStates.nextReviewAt),
        lte(reviewStates.nextReviewAt, nowIso),
      ),
    )
    .all();

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
  return {
    tasks: tasks.map((task) => ({
      task: taskToView(db, task),
      // 已撤销（含撤销前的作答）不回放结果：attempt 已 void，题面仅用于回看
      result: task.canceledAt === null && task.completedAt !== null ? replayAnswer(db, task) : null,
      canceled: task.canceledAt !== null,
    })),
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

/** 事务外取题：无库存时懒生成（AI 失败返回 null，不抛出） */
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
    console.warn(`[today] 题目生成失败（item=${itemId} type=${type}）：${(err as Error).message}`);
    return null;
  }
  return deps.acquire(db, itemId, type, now, excludeQuestionIds);
}

/** 在线生成并发度（预取未覆盖时的兜底路径）；GLM 串行每题约 4~5s */
const GENERATION_CONCURRENCY = 3;

/** 保序并发映射：结果顺序与输入一致；任一 fn 抛错整体 reject */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** 进程内串行化（双击/多标签同进程），跨进程由 uq_review_sessions_date + 全局锁兜底 */
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
    () => startTodaySessionLocked(db, deps, timezone, now),
    () => startTodaySessionLocked(db, deps, timezone, now),
  );
  startChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 持 question-generation 全局锁执行 start；等锁超时归一为 CONFLICT（前端提示稍候重试） */
async function startTodaySessionLocked(
  db: AppDatabase,
  deps: TodayDeps,
  timezone: string,
  now: Date,
): Promise<StartResponse> {
  try {
    return await withJobLock(db, 'question-generation', () =>
      startTodaySessionInner(db, deps, timezone, now),
    );
  } catch (err) {
    if (err instanceof JobLockTimeoutError) {
      throw appError('CONFLICT', '题目正在准备中，请稍候重试');
    }
    throw err;
  }
}

async function startTodaySessionInner(
  db: AppDatabase,
  deps: TodayDeps,
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
        eq(reviewStates.stable, 0),
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

  // ---- 3) 题目获取（事务外；取不到则跳过该任务/项，不占额度）----
  const plans: PlanTask[] = [];
  const acquiredQuestionIds = new Map<string, string[]>(); // itemId → 已占用题目（同 item 防重复取题）
  const markAcquired = (itemId: string, questionId: string): void => {
    const list = acquiredQuestionIds.get(itemId);
    if (list) list.push(questionId);
    else acquiredQuestionIds.set(itemId, [questionId]);
  };
  // 同 item 的多维度必须串行（防并发取到同题）；item 间并发 3；plans 顺序与串行实现一致
  const dueGroups = new Map<string, typeof dueRows>();
  for (const row of dueRows) {
    const list = dueGroups.get(row.item.id);
    if (list) list.push(row);
    else dueGroups.set(row.item.id, [row]);
  }
  const dueAcquired = await mapLimit(
    [...dueGroups.values()],
    GENERATION_CONCURRENCY,
    async (rows) => {
      const acquired: {
        row: (typeof rows)[number];
        taskType: 'understanding' | 'cloze' | 'production';
        q: QuestionRow | null;
      }[] = [];
      const exclude: string[] = [];
      for (const row of rows) {
        const dimension = row.state.dimension as Dimension;
        // P 维度按阶段取题（PRODUCT §6.3）：L1-2 填空；L3 哈希奇偶混合；L4+ 表达题
        const taskType: 'understanding' | 'cloze' | 'production' =
          dimension === 'understanding'
            ? 'understanding'
            : productionQuestionTypeFor(row.item.id, row.state.level);
        const q = await acquireWithGenerate(db, deps, row.item.id, taskType, now, exclude);
        if (q) exclude.push(q.id);
        acquired.push({ row, taskType, q });
      }
      return acquired;
    },
  );
  for (const group of dueAcquired) {
    for (const { row, taskType, q } of group) {
      if (!q) {
        console.warn(
          `[today] start 跳过到期任务：item=${row.item.id} dim=${row.state.dimension}（无可用题目）`,
        );
        continue;
      }
      markAcquired(row.item.id, q.id);
      plans.push({
        itemId: row.item.id,
        dimension: row.state.dimension as Dimension,
        taskType,
        questionId: q.id,
        origin: 'base',
      });
    }
  }
  const learnAcquired = await mapLimit(learnItems, GENERATION_CONCURRENCY, async (item) => {
    const q = await acquireWithGenerate(db, deps, item.id, 'understanding', now);
    return { item, q };
  });
  for (const { item, q } of learnAcquired) {
    if (!q) {
      console.warn(`[today] start 跳过新项：item=${item.id}（Learn 题生成失败，不占额度）`);
      continue;
    }
    markAcquired(item.id, q.id);
    plans.push({
      itemId: item.id,
      dimension: 'understanding',
      taskType: 'learn',
      questionId: q.id,
      origin: 'base',
    });
  }

  // ---- 3A) Read 补强（PRODUCT §8.2）：Read 答错置旗项 → 每项 1 题正式理解复习 ----
  // 每项最多 1 个（去重）；无题且 AI 生成失败则跳过；计入 base_task_count/progress/daily_stats。
  const flaggedItems = db
    .select()
    .from(learningItems)
    .where(
      and(
        eq(learningItems.status, 'active'),
        eq(learningItems.queueState, 'started'),
        eq(learningItems.needsReinforcement, 1),
      ),
    )
    .orderBy(asc(learningItems.id))
    .all();
  for (const item of flaggedItems) {
    const exclude = acquiredQuestionIds.get(item.id) ?? [];
    const q = await acquireWithGenerate(db, deps, item.id, 'understanding', now, exclude);
    if (!q) {
      console.warn(`[today] start 跳过 Read 补强：item=${item.id}（无可用题目）`);
      continue;
    }
    markAcquired(item.id, q.id);
    plans.push({
      itemId: item.id,
      dimension: 'understanding',
      taskType: 'understanding',
      questionId: q.id,
      origin: 'read_reinforcement',
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
          }
        : activeResponse(db, again);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /api/today/extend：同日追加学习
// ---------------------------------------------------------------------------

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
 * 持 question-generation 全局锁执行 extend；等锁超时归一为 CONFLICT（与 start/practice 一致）。
 */
export async function extendTodaySession(
  db: AppDatabase,
  deps: TodayDeps,
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

  try {
    return await withJobLock(db, 'question-generation', async () => {
      // 题目获取在事务外（库存优先、懒生成兜底）；失败跳过不占额度，全部失败则整体报错
      const acquired: { itemId: string; questionId: string }[] = [];
      for (const item of candidates) {
        const q = await acquireWithGenerate(db, deps, item.id, 'understanding', now);
        if (q) acquired.push({ itemId: item.id, questionId: q.id });
        else console.warn(`[today] extend 跳过新项：item=${item.id}（Learn 题生成失败，不占额度）`);
      }
      if (acquired.length === 0) throw appError('AI_PROVIDER_ERROR', '题目生成失败，请稍后重试');

      const nowIso = now.toISOString();
      return db.transaction((tx) => {
        // 事务内复查：会话仍处于完成态（并发下可能已被重新激活）
        const fresh = tx
          .select()
          .from(reviewSessions)
          .where(eq(reviewSessions.id, session.id))
          .get();
        if (!fresh) throw appError('INTERNAL', '会话不存在');
        if (fresh.completedAt === null) throw appError('CONFLICT', '会话已被重新激活');
        // 追加任务接在当日队列末尾（sortKey 从当前最大值起递增）
        const maxSort =
          tx
            .select({ m: sql<number>`max(${reviewTasks.sortKey})` })
            .from(reviewTasks)
            .where(eq(reviewTasks.sessionId, session.id))
            .get()?.m ?? 0;
        acquired.forEach((a, index) => {
          tx.insert(reviewTasks)
            .values({
              id: randomUUID(),
              sessionId: session.id,
              learningItemId: a.itemId,
              dimension: 'understanding',
              questionId: a.questionId,
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
        const updated = tx
          .select()
          .from(reviewSessions)
          .where(eq(reviewSessions.id, session.id))
          .get();
        if (!updated) throw appError('INTERNAL', '会话不存在');
        return activeResponse(tx, updated);
      });
    });
  } catch (err) {
    if (err instanceof JobLockTimeoutError) {
      throw appError('CONFLICT', '题目正在准备中，请稍候重试');
    }
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
    };
    if (!Array.isArray(c.segments) || typeof c.corrected !== 'string') return null;
    return {
      segments: c.segments,
      correctedSentence: c.corrected,
      betterVersion: typeof c.better === 'string' ? c.better : null,
    };
  } catch {
    return null;
  }
}

/** 幂等回放：已结算任务返回首次结算结果摘要 */
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
  // 表达题：回放首次批改 correction 与首次 personalExampleSaved（post 快照 exampleId）
  const correction = isProduction ? parseCorrectionView(attempt?.correctionJson ?? null) : null;
  const post = parseSnapshot(attempt?.postStateJson ?? null);
  return {
    result,
    outcomeSource: (attempt?.outcomeSource as AnswerResponse['outcomeSource']) ?? null,
    correct: result !== 'fail',
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

export async function answerTodayTask(
  db: AppDatabase,
  deps: TodayDeps,
  _timezone: string,
  now: Date,
  taskId: string,
  body: AnswerRequest,
): Promise<AnswerResponse> {
  const task = db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get();
  if (!task) throw appError('NOT_FOUND', '任务不存在');
  if (task.canceledAt !== null) throw appError('CONFLICT', '该任务已撤销');

  // 幂等：已结算 → 回放首次结果（不重复写 attempt / 推进状态）
  if (task.completedAt !== null) return replayAnswer(db, task);

  const session = db
    .select()
    .from(reviewSessions)
    .where(eq(reviewSessions.id, task.sessionId))
    .get();
  if (!session) throw appError('INTERNAL', '会话不存在');
  if (session.completedAt !== null) throw appError('CONFLICT', '会话已完成');

  const question = task.questionId
    ? (db.select().from(questions).where(eq(questions.id, task.questionId)).get() ?? null)
    : null;
  if (!question) throw appError('CONFLICT', '该任务没有可用题目');

  const isCloze = question.type === 'cloze';
  const isProduction = question.type === 'production';
  if (isCloze && !body.answerText) {
    throw appError('VALIDATION_ERROR', '填空题必须提交 answerText');
  }
  if (isProduction && !body.answerText) {
    throw appError('VALIDATION_ERROR', '表达题必须提交 answerText');
  }
  // Recall 判定契约（understanding 复习与 learn 新学"初见即回忆"共用，判定完全一致）
  const isRecallTask = task.taskType === 'understanding' || task.taskType === 'learn';
  if (!isCloze && !isProduction && !isRecallTask && !body.selectedOptionId) {
    throw appError('VALIDATION_ERROR', '选择题必须提交 selectedOptionId');
  }
  if (isRecallTask && !body.recall && !body.selectedOptionId) {
    throw appError('VALIDATION_ERROR', 'Recall 题必须提交 recall 或 selectedOptionId');
  }

  // ---- 事务外：评估（表达题走 check_production 实时批改）----
  let production: ProductionEvaluation | null = null;
  let outcome: EvaluateOutcome;
  if (isProduction) {
    try {
      production = await deps.evaluateProduction(db, question, body.answerText!);
    } catch (err) {
      // 批改失败：不写任何数据，保留用户输入由前端重试（AI_RULES §14）
      if (err instanceof AppError && err.code !== 'AI_PROVIDER_ERROR') throw err;
      throw appError('AI_PROVIDER_ERROR', '批改失败，请重试');
    }
    outcome = { correct: production.result !== 'fail' };
  } else if (isCloze) {
    outcome = await deps.evaluateCloze(db, question, body.answerText!);
  } else if (isRecallTask && body.recall) {
    // Recall Card 直判：主动回忆（无提示）；understanding 与 learn（新词初见即回忆）共用，
    // cloze 误传 recall 不生效，落入 cloze 路径
    outcome = { correct: body.recall === 'recalled' };
  } else {
    outcome = deps.evaluateChoice(question, body.selectedOptionId!);
  }
  const correct = outcome.correct === true;
  const viewedSource = body.viewedSource === true;
  // Recall 判定（understanding 复习与 learn 新学共用）：recall→pass/fail；
  // hint 选择→对=assisted(basic_pass)/错=forgot(fail)；
  // 查看原句不再降档（Recall 卡默认展示 source_example）。cloze 旧语义不变。
  let outcomeSource: 'recalled' | 'assisted' | 'forgot' | null = null;
  let result: AnswerResponse['result'];
  if (isProduction) {
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
      [question.id],
    );
  }

  const nowIso = now.toISOString();

  // ---- 同步事务：结算写库（AI 已全部完成，回调严格同步）----
  return db.transaction((tx) => {
    const fresh = tx.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get();
    if (!fresh) throw appError('NOT_FOUND', '任务不存在');
    if (fresh.canceledAt !== null) throw appError('CONFLICT', '该任务已撤销');
    if (fresh.completedAt !== null) return replayAnswer(tx, fresh);

    const itemId = task.learningItemId;
    const pre = snapshotOf(tx, itemId);
    const reinforcementIds: string[] = [];

    if (task.taskType === 'learn') {
      // Learn Recall（方案 A）：三路径都完成新学——初始化 U(L1)+P 激活；
      // forgot/assisted 的揭示即教学时刻，明日以 Recall 短间隔回归。
      // 无论对错都已开始学 → queue_state='started' 且当日额度 +1。
      writeDimState(tx, itemId, 'understanding', deps.initialUnderstandingAfterLearn(now), nowIso);
      writeDimState(tx, itemId, 'production', deps.initialProductionActivation(now), nowIso);
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
      // 普通复习：review.advanceReviewState 推进该维度（含 streak 写回与 mastered 判定）
      deps.advance(tx, itemId, task.dimension as Dimension, { kind: result }, now);
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

    // 表达题：优质 corrected 句沉淀 Personal Example（PRODUCT §3.2/§7.5），
    // post 快照记录本次写入的 exampleId（坏题撤销依据）
    let personalSaved: PersonalExampleSaveResult = SKIP_PERSONAL;
    if (isProduction && production) {
      personalSaved = maybeSavePersonalExample(
        tx,
        task.learningItemId,
        {
          result: production.result,
          eligible: production.candidate.eligible,
          qualityScore: production.candidate.qualityScore,
          correctedSentence: production.correctedSentence,
          originalText: body.answerText!,
          betterVersion: production.betterVersion,
        },
        now,
      );
      if (personalSaved.exampleId) post.personalExampleId = personalSaved.exampleId;
    }

    const reveal = isCloze ? clozeReveal(question) : null;
    const explanation = isProduction
      ? production!.explanation
      : revealExplanation(question, correct);
    tx.insert(attempts)
      .values({
        id: randomUUID(),
        reviewTaskId: task.id,
        learningItemId: task.learningItemId,
        questionId: question.id,
        mode: 'today',
        answerText: body.answerText ?? null,
        // recall 直判时归一化丢弃并存选项，避免统计层误读
        selectedOptionId: isRecallTask && body.recall ? null : (body.selectedOptionId ?? null),
        result,
        viewedSource: viewedSource ? 1 : 0,
        feedback: null,
        outcomeSource,
        correctionJson: production
          ? JSON.stringify({
              segments: production.segments,
              corrected: production.correctedSentence,
              better: production.betterVersion,
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

    // 造句历史裁剪：保留该 item 最近 10 条 production attempts（PRODUCT §7.5）
    if (isProduction) trimProductionHistory(tx, task.learningItemId);

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
      explanation,
      correctOptionId: !isCloze && !isProduction ? question.correctOptionId : null,
      completeSentence: reveal?.completeSentence ?? null,
      acceptedAnswer: reveal?.acceptedAnswer ?? null,
      correction: production
        ? {
            segments: production.segments,
            correctedSentence: production.correctedSentence,
            betterVersion: production.betterVersion,
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

export function deferTodayTask(db: AppDatabase, taskId: string): LaterResponse {
  return db.transaction((tx) => {
    const task = requireTask(tx, taskId);
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

export function reportBadQuestion(db: AppDatabase, taskId: string, now: Date): BadQuestionResponse {
  const nowIso = now.toISOString();
  return db.transaction((tx) => {
    const task = requireTask(tx, taskId);
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

    const session = tx
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.id, task.sessionId))
      .get();
    if (!session) throw appError('INTERNAL', '会话不存在');

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
  const today = localDateString(now, timezone);
  const nowIso = now.toISOString();
  return db.transaction((tx) => {
    const task = requireTask(tx, taskId);
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

    const session = tx
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.id, task.sessionId))
      .get();
    if (!session) throw appError('INTERNAL', '会话不存在');
    if (session.sessionDate !== today) throw appError('CONFLICT', '会话已过期，无法反馈');

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
      const allStable = states.length === 2 && states.every((s) => s.stable === 1);
      const item = tx.select().from(learningItems).where(eq(learningItems.id, itemId)).get();
      if (!allStable && item?.status === 'mastered') {
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
      .set({ feedback, result: adjusted, postStateJson: JSON.stringify(newPost) })
      .where(eq(attempts.id, attempt.id))
      .run();

    return { ok: true as const, adjustedResult: adjusted };
  });
}
