import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  CONTENT_LEVELS,
  DEFAULT_CONTENT_LEVEL,
  MASTERED_STABILITY_DAYS,
  READ_FOCUS_MAX,
  READ_KEEP_DAYS,
  READ_OLD_MAX,
  RECENT_READS_ON_HOME,
  type GenerateReadResult,
  type ReadArticleView,
  type ReadCheckResponse,
  type ReadFavoriteRequest,
  type ReadFavoriteResponse,
  type ReadGenerateResponse,
  type ReadHistoryQuery,
  type ReadHistoryResponse,
} from '@el/shared';
import type { AppDatabase } from '../../db/client.js';
import {
  attempts,
  learningItems,
  readArticleItems,
  readArticles,
  reviewStates,
  settings,
} from '../../db/schema.js';
import { englishWordCount } from '../../ai/invariants.js';
import { AppError, appError } from '../../lib/errors.js';
import { isV2CutoverApplied } from '../review/v2-cutover.js';

const DAY_MS = 24 * 3600 * 1000;

/** focus「近期弱」排序：近 30 天正式复习 fail 数窗口 */
export const FOCUS_FAIL_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// 选词输入（传给 generateRead 的结构化变量）
// ---------------------------------------------------------------------------

export interface ReadItemVar {
  id: string;
  target: string;
  meaning: string;
}

export interface ReadSelection {
  focusItems: ReadItemVar[];
  oldItems: ReadItemVar[];
  contentLevel: string;
  /** 最近 3 篇的 type（时间正序），供 Prompt 避免类型连续重复 */
  recentReadTypes: string[];
}

export interface ReadGeneration {
  data: GenerateReadResult;
  meta: { key: string; version: number; hash: string };
  model: string;
}

// ---------------------------------------------------------------------------
// 依赖接口（AI 适配层；默认绑定 completeStructured + runtime，测试可注入 fake）
// ---------------------------------------------------------------------------

export interface ReadDeps {
  generate(input: ReadSelection): Promise<ReadGeneration>;
}

const COMPLETE_PATH = '../../ai/complete.js';
const RUNTIME_PATH = '../../ai/runtime.js';

type UnknownModule = Record<string, unknown>;

function requireFn(mod: UnknownModule, name: string): (...args: unknown[]) => unknown {
  const f = mod[name];
  if (typeof f !== 'function') {
    throw new Error(`依赖模块缺少导出函数：${name}`);
  }
  return f as (...args: unknown[]) => unknown;
}

/** 绑定真实 AI 链路（completeStructured：Schema + 机器不变式 + 重试） */
export async function loadRealReadDeps(): Promise<ReadDeps> {
  const completeMod = (await import(COMPLETE_PATH)) as UnknownModule;
  const runtimeMod = (await import(RUNTIME_PATH)) as UnknownModule;
  const completeStructuredFn = requireFn(completeMod, 'completeStructured');
  const getAiRuntime = runtimeMod.getAiRuntime as (() => unknown) | undefined;
  if (typeof getAiRuntime !== 'function') {
    throw new Error('依赖模块缺少导出函数：getAiRuntime');
  }

  return {
    async generate(input) {
      const runtime = getAiRuntime() as {
        provider: unknown;
        config: unknown;
        registry: unknown;
      } | null;
      if (!runtime) throw appError('AI_PROVIDER_ERROR', 'AI runtime 未初始化，无法生成文章');
      const { data, meta, model } = (await completeStructuredFn(
        { provider: runtime.provider, config: runtime.config, registry: runtime.registry },
        'generateRead',
        {
          content_level: input.contentLevel,
          focus_items: input.focusItems,
          old_items: input.oldItems,
          recent_read_types: input.recentReadTypes,
          focus_list: input.focusItems
            .map((f) => `- learning_item_id: ${f.id} | word: ${f.target} | meaning: ${f.meaning}`)
            .join('\n'),
          old_list:
            input.oldItems.length > 0
              ? input.oldItems.map((f) => `- ${f.target}（${f.meaning}）`).join('\n')
              : '（无）',
        },
      )) as {
        data: GenerateReadResult;
        meta: { key: string; version: number; hash: string };
        model: string;
      };
      return { data, meta: { key: meta.key, version: meta.version, hash: meta.hash }, model };
    },
  };
}

let cachedRealDeps: ReadDeps | null = null;
let depsOverride: ReadDeps | null = null;

export async function resolveReadDeps(): Promise<ReadDeps> {
  if (depsOverride) return depsOverride;
  cachedRealDeps ??= await loadRealReadDeps();
  return cachedRealDeps;
}

/** 测试专用依赖注入（生产不调用） */
export function setReadDepsForTests(deps: ReadDeps | null): void {
  depsOverride = deps;
}

// ---------------------------------------------------------------------------
// 选词（PRODUCT §8.1：focus 3～5 弱项 + old 3–5 稳定项）
// ---------------------------------------------------------------------------

type ItemRow = typeof learningItems.$inferSelect;
type StateRow = typeof reviewStates.$inferSelect;

interface Candidate {
  item: ItemRow;
  states: StateRow[];
  /** 近 30 天正式复习（mode=today）非 void fail 数 */
  failCount: number;
  /** production 维 wrong_streak（无行 = 0） */
  prodWrongStreak: number;
  /** 激活维（stability 非 NULL）最小 stability */
  minStability: number;
  /** 两维最近一次复习时间（null = 从未） */
  lastReviewAt: string | null;
}

/** 两维均越过掌握线（S≥120）= 理解与表达都稳定（mastered 语义） */
function isTwoDimStable(states: StateRow[]): boolean {
  const u = states.find((s) => s.dimension === 'understanding');
  const p = states.find((s) => s.dimension === 'production');
  const mastered = (s: StateRow | undefined) =>
    typeof s?.stability === 'number' && s.stability >= MASTERED_STABILITY_DAYS;
  return !!u && !!p && mastered(u) && mastered(p);
}

/** settings 的 content_level（缺省 B1；非法值回退默认） */
function readContentLevel(db: AppDatabase): string {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  const level = row?.contentLevel;
  return level && (CONTENT_LEVELS as readonly string[]).includes(level)
    ? level
    : DEFAULT_CONTENT_LEVEL;
}

/**
 * 选词（可测试的确定性规则，测试固定断言）：
 * - focus：active+started、至少一行 review_states、且非「两维掌握（S≥120）」的项，按
 *   ① 近 30 天 today-fail 数 DESC；② production wrong_streak DESC；
 *   ③ 激活维最小 stability ASC；④ lastReviewAt DESC（最近复习优先）；⑤ id ASC。
 *   取前 READ_FOCUS_MAX 个；不足按实际数量；0 个抛 CONFLICT。
 * - old：mastered 或两维 stable 项（排除 focus），按 lastReviewAt ASC（最久未复习优先）、id ASC。
 * - recentReadTypes：最近 3 篇文章的 type（时间正序）。
 */
export function buildReadSelection(db: AppDatabase, now: Date): ReadSelection {
  const rows = db
    .select({ item: learningItems, state: reviewStates })
    .from(reviewStates)
    .innerJoin(learningItems, eq(learningItems.id, reviewStates.learningItemId))
    .where(
      and(
        inArray(learningItems.status, ['active', 'mastered']),
        eq(learningItems.queueState, 'started'),
      ),
    )
    .all();

  const grouped = new Map<string, { item: ItemRow; states: StateRow[] }>();
  for (const row of rows) {
    const g = grouped.get(row.item.id);
    if (g) g.states.push(row.state);
    else grouped.set(row.item.id, { item: row.item, states: [row.state] });
  }

  // 近 30 天 today-fail 计数（排除已撤销）
  const failCounts = new Map<string, number>();
  if (grouped.size > 0) {
    const sinceIso = new Date(now.getTime() - FOCUS_FAIL_WINDOW_DAYS * DAY_MS).toISOString();
    const failRows = db
      .select({ itemId: attempts.learningItemId, n: sql<number>`count(*)` })
      .from(attempts)
      .where(
        and(
          eq(attempts.mode, 'today'),
          eq(attempts.result, 'fail'),
          isNull(attempts.voidedAt),
          gte(attempts.createdAt, sinceIso),
          inArray(attempts.learningItemId, [...grouped.keys()]),
        ),
      )
      .groupBy(attempts.learningItemId)
      .all();
    for (const r of failRows) failCounts.set(r.itemId, Number(r.n));
  }

  const candidates: Candidate[] = [...grouped.values()].map(({ item, states }) => {
    const prodWrong = Math.max(
      0,
      ...states.filter((s) => s.dimension === 'production').map((s) => s.wrongStreak),
    );
    const activeStability = states
      .map((s) => s.stability)
      .filter((x): x is number => typeof x === 'number');
    const last =
      states
        .map((s) => s.lastReviewAt)
        .filter((t): t is string => typeof t === 'string' && t.length > 0)
        .sort()
        .at(-1) ?? null;
    return {
      item,
      states,
      failCount: failCounts.get(item.id) ?? 0,
      prodWrongStreak: prodWrong,
      minStability: activeStability.length > 0 ? Math.min(...activeStability) : 0,
      lastReviewAt: last,
    };
  });

  const isOldQualifying = (c: Candidate) =>
    c.item.status === 'mastered' || isTwoDimStable(c.states);
  const focusCandidates = candidates
    .filter((c) => c.item.status === 'active' && !isOldQualifying(c))
    .sort(
      (a, b) =>
        b.failCount - a.failCount ||
        b.prodWrongStreak - a.prodWrongStreak ||
        a.minStability - b.minStability ||
        cmpDescNullable(a.lastReviewAt, b.lastReviewAt) ||
        a.item.id.localeCompare(b.item.id),
    )
    .slice(0, READ_FOCUS_MAX);
  if (focusCandidates.length === 0) {
    throw appError('CONFLICT', '没有可用于生成 Read 的学习项');
  }

  const focusIds = new Set(focusCandidates.map((c) => c.item.id));
  const oldCandidates = candidates
    .filter((c) => isOldQualifying(c) && !focusIds.has(c.item.id))
    .sort(
      (a, b) =>
        cmpAscNullable(a.lastReviewAt, b.lastReviewAt) || a.item.id.localeCompare(b.item.id),
    )
    .slice(0, READ_OLD_MAX);

  const recentTypes = db
    .select({ type: readArticles.type })
    .from(readArticles)
    .orderBy(desc(readArticles.createdAt), desc(readArticles.id))
    .limit(RECENT_READS_ON_HOME)
    .all()
    .map((r) => r.type)
    .reverse();

  const toVar = (c: Candidate): ReadItemVar => ({
    id: c.item.id,
    target: c.item.target,
    meaning: c.item.meaning,
  });
  return {
    focusItems: focusCandidates.map(toVar),
    oldItems: oldCandidates.map(toVar),
    contentLevel: readContentLevel(db),
    recentReadTypes: recentTypes,
  };
}

/** DESC 比较（值大者优先；null 排最后） */
function cmpDescNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b.localeCompare(a);
}

/** ASC 比较（值小者优先；null 视为最旧排最前） */
function cmpAscNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a.localeCompare(b);
}

// ---------------------------------------------------------------------------
// checks 存储（read_articles.checks_json）——V1 遗留数据只读；V2 新文章恒为 '[]'
// ---------------------------------------------------------------------------

export interface StoredReadCheck {
  id: string;
  learningItemId: string;
  question: string;
  options: Array<{ id: string; text: string }>;
  correctOptionId: string;
  explanation?: string | null;
  /** V1 首答记录（幂等 + 重启安全）；V2 起不再写入 */
  answered?: {
    selectedOptionId: string;
    correct: boolean;
    needsReinforcementMarked: boolean;
  } | null;
}

function parseChecks(json: string): StoredReadCheck[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredReadCheck[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// POST /api/read/generate
// ---------------------------------------------------------------------------

/**
 * 实时生成一篇 Read（PRODUCT §8.1，V2 纯阅读）：
 * 选词 → AI 生成（事务外，completeStructured 含词数/coverage/surface_form 不变式，
 * Schema strict 拒绝含 checks 的输出并重试）→ 同步事务落库（article + items，
 * checks_json='[]'）→ 返回视图（checks=[]）。
 */
export async function generateReadArticle(
  db: AppDatabase,
  deps: ReadDeps,
  now: Date,
): Promise<ReadGenerateResponse> {
  const selection = buildReadSelection(db, now);

  let generation: ReadGeneration;
  try {
    generation = await deps.generate(selection);
  } catch (err) {
    // 失败必落日志：真实原因（如不变式违规详情）只留服务端，客户端只见通用 502 文案
    console.error('[read/generate] 生成失败：', err instanceof Error ? err.message : err);
    // AI 类失败（AiStructuredError 等 code=AI_PROVIDER_ERROR）归一化为通用文案；非 AI 的 AppError 原样透传
    if (err instanceof AppError && err.code !== 'AI_PROVIDER_ERROR') throw err;
    throw appError('AI_PROVIDER_ERROR', '文章生成失败，请稍候重试');
  }
  const { data, meta, model } = generation;

  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + READ_KEEP_DAYS * DAY_MS).toISOString();
  const articleId = randomUUID();
  const coverageById = new Map(data.coverage.map((c) => [c.learning_item_id, c.surface_form]));
  const focusIds = new Set(selection.focusItems.map((f) => f.id));

  db.transaction((tx) => {
    tx.insert(readArticles)
      .values({
        id: articleId,
        title: data.title,
        body: data.body,
        type: data.type,
        contentLevel: selection.contentLevel,
        favorite: 0,
        promptKey: meta.key,
        promptVersion: meta.version,
        promptHash: meta.hash,
        model,
        // V2：纯阅读，不再携带检查题
        checksJson: '[]',
        createdAt: nowIso,
        expiresAt: expiresIso,
      })
      .run();
    for (const f of selection.focusItems) {
      tx.insert(readArticleItems)
        .values({
          readArticleId: articleId,
          learningItemId: f.id,
          role: 'focus',
          highlighted: 1,
          // 持久化 AI coverage 声明的实际形式，供详情端点回放
          surfaceForm: coverageById.get(f.id) ?? f.target,
        })
        .run();
    }
    for (const o of selection.oldItems) {
      if (focusIds.has(o.id)) continue;
      tx.insert(readArticleItems)
        .values({
          readArticleId: articleId,
          learningItemId: o.id,
          role: 'old',
          highlighted: 0,
        })
        .run();
    }
  });

  return {
    id: articleId,
    title: data.title,
    type: data.type,
    body: data.body,
    contentLevel: selection.contentLevel,
    favorite: false,
    createdAt: nowIso,
    expiresAt: expiresIso,
    focusItems: selection.focusItems.map((f) => ({
      learningItemId: f.id,
      target: f.target,
      surfaceForm: coverageById.get(f.id) ?? f.target,
    })),
    oldItems: selection.oldItems
      .filter((o) => !focusIds.has(o.id))
      .map((o) => ({ learningItemId: o.id, target: o.target })),
    checks: [],
  };
}

// ---------------------------------------------------------------------------
// GET /api/read/:id（文章详情：历史项回源）
// ---------------------------------------------------------------------------

/** 已过期（expires_at 非空且 <= now）与不存在同样 404；收藏（expires_at=null）永久可见 */
export function getReadArticle(db: AppDatabase, articleId: string, now: Date): ReadArticleView {
  const article = db.select().from(readArticles).where(eq(readArticles.id, articleId)).get();
  if (!article) throw appError('NOT_FOUND', '文章不存在');
  if (article.expiresAt && article.expiresAt <= now.toISOString()) {
    throw appError('NOT_FOUND', '文章已过期');
  }

  const items = db
    .select()
    .from(readArticleItems)
    .where(eq(readArticleItems.readArticleId, articleId))
    .all();
  const itemRows = items.length
    ? db.select({ id: learningItems.id, target: learningItems.target }).from(learningItems).all()
    : [];
  const targetById = new Map(itemRows.map((i) => [i.id, i.target]));

  return {
    id: article.id,
    title: article.title,
    type: article.type as ReadArticleView['type'],
    body: article.body,
    contentLevel: article.contentLevel,
    favorite: article.favorite === 1,
    createdAt: article.createdAt,
    expiresAt: article.expiresAt,
    focusItems: items
      .filter((i) => i.role === 'focus')
      .map((i) => ({
        learningItemId: i.learningItemId,
        target: targetById.get(i.learningItemId) ?? '',
        surfaceForm: i.surfaceForm ?? targetById.get(i.learningItemId) ?? '',
      })),
    oldItems: items
      .filter((i) => i.role === 'old')
      .map((i) => ({
        learningItemId: i.learningItemId,
        target: targetById.get(i.learningItemId) ?? '',
      })),
    checks: parseChecks(article.checksJson).map((c) => ({
      checkId: c.id,
      learningItemId: c.learningItemId,
      target: targetById.get(c.learningItemId) ?? '',
      question: c.question,
      options: c.options,
      // V1 遗留只读回放：已答回放首答与当时已揭晓的正确选项；未答不泄露答案
      answered: c.answered
        ? {
            selectedOptionId: c.answered.selectedOptionId,
            correctOptionId: c.correctOptionId,
            correct: c.answered.correct,
          }
        : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/read/history
// ---------------------------------------------------------------------------

/** 排除已过期（expires_at 非空且 <= now）；favorite 筛选；created DESC 分页 */
export function listReadHistory(
  db: AppDatabase,
  query: ReadHistoryQuery,
  now: Date,
): ReadHistoryResponse {
  const nowIso = now.toISOString();
  const conditions = [or(isNull(readArticles.expiresAt), gt(readArticles.expiresAt, nowIso))!];
  if (query.favorite !== null) {
    conditions.push(eq(readArticles.favorite, query.favorite ? 1 : 0));
  }

  const rows = db
    .select()
    .from(readArticles)
    .where(and(...conditions))
    .orderBy(desc(readArticles.createdAt), desc(readArticles.id))
    .all();
  const start = (query.page - 1) * query.pageSize;
  return {
    items: rows.slice(start, start + query.pageSize).map((a) => ({
      id: a.id,
      title: a.title,
      type: a.type as ReadArticleView['type'],
      favorite: a.favorite === 1,
      createdAt: a.createdAt,
      wordCount: englishWordCount(a.body),
    })),
    total: rows.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ---------------------------------------------------------------------------
// POST /api/read/:id/favorite
// ---------------------------------------------------------------------------

/** 收藏=永久（expires_at=null）；取消收藏恢复 created+30 天（可能立即过期，属预期） */
export function setReadFavorite(
  db: AppDatabase,
  articleId: string,
  body: ReadFavoriteRequest,
): ReadFavoriteResponse {
  return db.transaction((tx) => {
    const article = tx.select().from(readArticles).where(eq(readArticles.id, articleId)).get();
    if (!article) throw appError('NOT_FOUND', '文章不存在');
    const expiresAt = body.favorite
      ? null
      : new Date(new Date(article.createdAt).getTime() + READ_KEEP_DAYS * DAY_MS).toISOString();
    tx.update(readArticles)
      .set({ favorite: body.favorite ? 1 : 0, expiresAt })
      .where(eq(readArticles.id, articleId))
      .run();
    return { ok: true as const, favorite: body.favorite };
  });
}

// ---------------------------------------------------------------------------
// POST /api/read/:id/check
// ---------------------------------------------------------------------------

/**
 * 轻量检查判定（PRODUCT §8.2，V1 遗留兼容路径）：
 * - V2 cutover 后检查题停用：任何提交（旧/新文章）一律 409，不写 attempt、不置旗；
 * - cutover 前的遗留窗口仍可判定（供最后一次 V1.2 会话收尾）：
 *   与 checks_json 的 correctOptionId 比对 → correct；写 attempt（mode='read_check'，
 *   不计 daily_stats/不推进 review_states/不影响 Today）；但不再置 needs_reinforcement
 *   （V2：Read 路径不产生补强，旧行的清旗归 cutover/正式复习）；
 * - 同 checkId 只结算一次：首答结果写入 checks_json.answered，重复提交幂等返回。
 */
export function answerReadCheck(
  db: AppDatabase,
  articleId: string,
  body: { checkId: string; selectedOptionId: string },
  now: Date,
): ReadCheckResponse {
  if (isV2CutoverApplied(db)) {
    throw appError('CONFLICT', 'Read 检查题已停用，请刷新页面');
  }

  const nowIso = now.toISOString();
  return db.transaction((tx) => {
    const article = tx.select().from(readArticles).where(eq(readArticles.id, articleId)).get();
    if (!article) throw appError('NOT_FOUND', '文章不存在');

    const checks = parseChecks(article.checksJson);
    const idx = checks.findIndex((c) => c.id === body.checkId);
    if (idx === -1) throw appError('NOT_FOUND', '检查题不存在');
    const check = checks[idx]!;

    // 幂等：返回首次结果（即使提交了不同选项）
    if (check.answered) {
      return {
        correct: check.answered.correct,
        correctOptionId: check.correctOptionId,
        needsReinforcementMarked: check.answered.needsReinforcementMarked,
      };
    }

    const item = tx
      .select()
      .from(learningItems)
      .where(eq(learningItems.id, check.learningItemId))
      .get();
    if (!item) throw appError('NOT_FOUND', '学习项不存在');

    const correct = check.correctOptionId === body.selectedOptionId;

    tx.insert(attempts)
      .values({
        id: randomUUID(),
        reviewTaskId: null,
        learningItemId: item.id,
        questionId: null,
        mode: 'read_check',
        answerText: null,
        selectedOptionId: body.selectedOptionId,
        result: correct ? 'pass' : 'fail',
        viewedSource: 0,
        feedback: null,
        correctionJson: null,
        explanation: check.explanation ?? null,
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

    checks[idx] = {
      ...check,
      answered: {
        selectedOptionId: body.selectedOptionId,
        correct,
        // V2：不再置补强旗
        needsReinforcementMarked: false,
      },
    };
    tx.update(readArticles)
      .set({ checksJson: JSON.stringify(checks) })
      .where(eq(readArticles.id, articleId))
      .run();

    return { correct, correctOptionId: check.correctOptionId, needsReinforcementMarked: false };
  });
}
