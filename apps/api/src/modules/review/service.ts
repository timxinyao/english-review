import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import {
  PRODUCTION_FIRST_REVIEW_DELAY_DAYS,
  localDateString,
  type ReviewDimension,
} from '@el/shared';
import { learningItems, reviewStates } from '../../db/schema.js';
import { effectiveProductionEnabled, isMastered } from './goals.js';
import type { DbExecutor, DbTx } from '../questions/service.js';
import type { ReviewOutcome } from './fsrs-engine.js';
import { advanceCard, cardFromSnapshot, ratingOf } from './fsrs-engine.js';

export { isMastered } from './goals.js';

// ---------- 类型（today 模块依赖的公开契约）----------

/** ReviewOutcome 定义已移至 fsrs-engine.ts（避免循环引用）；re-export 保持消费方 import 路径不变 */
export type { ReviewOutcome } from './fsrs-engine.js';

/** 维度复习状态快照（纯函数进出；时间一律 ISO UTC 字符串；D/S NULL=未激活） */
export interface ReviewStateSnapshot {
  difficulty: number | null;
  stability: number | null;
  reps: number;
  lapses: number;
  nextReviewAt: string | null;
  lastReviewAt: string | null;
  correctStreak: number;
  wrongStreak: number;
}

// ---------- 内部工具 ----------

const MS_PER_DAY = 86_400_000;

function addDaysIso(now: Date, days: number): string {
  return new Date(now.getTime() + Math.round(days * MS_PER_DAY)).toISOString();
}

/** 未激活快照（D/S/reps/lapses 全零，无排期） */
export const INACTIVE_SNAPSHOT: ReviewStateSnapshot = {
  difficulty: null,
  stability: null,
  reps: 0,
  lapses: 0,
  nextReviewAt: null,
  lastReviewAt: null,
  correctStreak: 0,
  wrongStreak: 0,
};

function toSnapshot(row: typeof reviewStates.$inferSelect): ReviewStateSnapshot {
  return {
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

// ---------- 状态机纯函数（FSRS 换轨，PRODUCT_DESIGN §6.2 2026-10）----------

/**
 * 单次作答演进：行快照 → FSRS Card → 按 outcome 评分推进 → 映射回快照。
 * 间隔 clamp（1..365 天）在 fsrs-engine.advanceCard 内；mastered 项照常排期（无 null 吸收态）。
 * streaks 规则不变：pass 记对；basic_pass/fail 清对；fail 记错。
 */
export function computeNextReviewState(
  current: ReviewStateSnapshot,
  outcome: ReviewOutcome,
  now: Date,
): ReviewStateSnapshot {
  const card = advanceCard(cardFromSnapshot(current, now), now, ratingOf(outcome));

  const correctStreak = outcome.kind === 'pass' ? current.correctStreak + 1 : 0;
  const wrongStreak = outcome.kind === 'fail' ? current.wrongStreak + 1 : 0;

  return {
    difficulty: card.difficulty,
    stability: card.stability,
    reps: card.reps,
    lapses: card.lapses,
    nextReviewAt: card.due.toISOString(),
    lastReviewAt: now.toISOString(),
    correctStreak,
    wrongStreak,
  };
}

/** Learn 首答即首评分：直接以判定 outcome 从未激活态建 U 卡（PRODUCT §6.3 方案 A） */
export function initialUnderstandingAfterLearn(
  outcome: ReviewOutcome,
  now: Date,
): ReviewStateSnapshot {
  return computeNextReviewState(INACTIVE_SNAPSHOT, outcome, now);
}

/** Production 首次激活：D/S 未激活、reps/lapses=0、next=+1d（激活但未首答） */
export function initialProductionActivation(now: Date): ReviewStateSnapshot {
  return {
    difficulty: null,
    stability: null,
    reps: 0,
    lapses: 0,
    nextReviewAt: addDaysIso(now, PRODUCTION_FIRST_REVIEW_DELAY_DAYS),
    lastReviewAt: null,
    correctStreak: 0,
    wrongStreak: 0,
  };
}

/** 目标或 Stage 变化后重算 active/mastered；paused/archived 原样保留。 */
export function reconcileItemStatus(tx: DbTx, itemId: string, nowIso: string): void {
  const item = tx.select().from(learningItems).where(eq(learningItems.id, itemId)).get();
  if (!item) throw new Error(`Learning item not found: ${itemId}`);
  if (item.status === 'paused' || item.status === 'archived') return;
  const states = tx
    .select()
    .from(reviewStates)
    .where(eq(reviewStates.learningItemId, itemId))
    .all();
  const u = states.find((state) => state.dimension === 'understanding');
  const p = states.find((state) => state.dimension === 'production');
  const mastered = isMastered(
    u ? toSnapshot(u) : INACTIVE_SNAPSHOT,
    p ? toSnapshot(p) : INACTIVE_SNAPSHOT,
    effectiveProductionEnabled(item),
  );
  const status = mastered ? 'mastered' : 'active';
  if (item.status !== status) {
    tx.update(learningItems)
      .set({ status, updatedAt: nowIso })
      .where(eq(learningItems.id, itemId))
      .run();
  }
}

/** 首次打开造句目标的 started Item：只给未激活 P 安排下一本地日，不覆盖既有进度。 */
export function ensureProductionDueAfterGoalEnabled(
  tx: DbTx,
  itemId: string,
  now: Date,
  timezone: string,
): void {
  const p = tx
    .select()
    .from(reviewStates)
    .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, 'production')))
    .get();
  if (
    p &&
    (p.difficulty !== null ||
      p.stability !== null ||
      p.reps !== 0 ||
      p.lapses !== 0 ||
      p.nextReviewAt !== null ||
      p.lastReviewAt !== null)
  )
    return;
  const today = localDateString(now, timezone);
  const nextDay = new Date(Date.parse(`${today}T00:00:00.000Z`) + MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
  let low = now.getTime();
  let high = low + 48 * 60 * 60 * 1000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (localDateString(new Date(mid), timezone) < nextDay) low = mid + 1;
    else high = mid;
  }
  const nextReviewAt = new Date(low).toISOString();
  const nowIso = now.toISOString();
  if (p) {
    tx.update(reviewStates)
      .set({ nextReviewAt, updatedAt: nowIso })
      .where(eq(reviewStates.id, p.id))
      .run();
  } else {
    tx.insert(reviewStates)
      .values({
        id: randomUUID(),
        learningItemId: itemId,
        dimension: 'production',
        difficulty: null,
        stability: null,
        reps: 0,
        lapses: 0,
        nextReviewAt,
        lastReviewAt: null,
        correctStreak: 0,
        wrongStreak: 0,
        updatedAt: nowIso,
      })
      .run();
  }
}

// ---------- 落库（必须由本模块执行，AGENTS.md §5）----------

/**
 * 读行 → 纯函数计算 → 写回（含 correct/wrong streak）→ 目标内维度均越过掌握线（S≥120）则
 * item.status='mastered'（reconcileItemStatus 判定）。
 * better-sqlite3 同步事务约束：只接受 tx（事务回调参数），体内全部同步执行。
 * pre=null 表示行原本不存在（按未激活快照计算，如 L0 输入按 L1 处理）。
 */
export function advanceReviewState(
  tx: DbTx,
  itemId: string,
  dimension: ReviewDimension,
  outcome: ReviewOutcome,
  now: Date,
): { pre: ReviewStateSnapshot | null; post: ReviewStateSnapshot } {
  const nowIso = now.toISOString();
  const existing = tx
    .select()
    .from(reviewStates)
    .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dimension)))
    .get();
  const pre = existing ? toSnapshot(existing) : null;
  const post = computeNextReviewState(pre ?? INACTIVE_SNAPSHOT, outcome, now);

  const values = {
    difficulty: post.difficulty,
    stability: post.stability,
    reps: post.reps,
    lapses: post.lapses,
    nextReviewAt: post.nextReviewAt,
    lastReviewAt: post.lastReviewAt,
    correctStreak: post.correctStreak,
    wrongStreak: post.wrongStreak,
    updatedAt: nowIso,
  };
  const updated = tx
    .update(reviewStates)
    .set(values)
    .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dimension)))
    .run();
  if (updated.changes === 0) {
    tx.insert(reviewStates)
      .values({ id: randomUUID(), learningItemId: itemId, dimension, ...values })
      .run();
  }

  reconcileItemStatus(tx, itemId, nowIso);

  return { pre, post };
}

// ---------- 到期查询（供 prefetch job 使用；job 不直接写 SQL）----------

export interface UpcomingDueEntry {
  itemId: string;
  dimension: ReviewDimension;
  nextReviewAt: string;
}

/** 未来 horizon 天内将到期的 item×维度（item 须 active + started；含已过期） */
export function listUpcomingDue(
  db: DbExecutor,
  now: Date,
  horizonDays: number,
): UpcomingDueEntry[] {
  const horizonIso = addDaysIso(now, horizonDays);
  const rows = db
    .select({
      itemId: reviewStates.learningItemId,
      dimension: reviewStates.dimension,
      nextReviewAt: reviewStates.nextReviewAt,
      itemType: learningItems.type,
      productionEnabledOverride: learningItems.productionEnabledOverride,
    })
    .from(reviewStates)
    .innerJoin(learningItems, eq(learningItems.id, reviewStates.learningItemId))
    .where(
      and(
        isNotNull(reviewStates.nextReviewAt),
        lte(reviewStates.nextReviewAt, horizonIso),
        eq(learningItems.status, 'active'),
        eq(learningItems.queueState, 'started'),
      ),
    )
    .orderBy(reviewStates.nextReviewAt)
    .all();
  return rows
    .filter(
      (row) =>
        row.dimension === 'understanding' ||
        effectiveProductionEnabled({
          type: row.itemType,
          productionEnabledOverride: row.productionEnabledOverride,
        }),
    )
    .map(({ itemId, dimension, nextReviewAt }) => ({
      itemId,
      dimension,
      nextReviewAt,
    })) as UpcomingDueEntry[];
}
