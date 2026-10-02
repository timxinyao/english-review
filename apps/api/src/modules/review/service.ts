import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import {
  BASIC_PASS_INTERVAL_FACTOR,
  FAIL_INTERVAL_FACTOR,
  INTERVALS_DAYS,
  LEVEL_MAX,
  LEVEL_MIN,
  MIN_INTERVAL_DAYS,
  PRODUCTION_FIRST_REVIEW_DELAY_DAYS,
  TOO_EASY_EXTRA_LEVELS,
  localDateString,
  type ReviewDimension,
} from '@el/shared';
import { learningItems, reviewStates } from '../../db/schema.js';
import { effectiveProductionEnabled, isMastered } from './goals.js';
import type { DbExecutor, DbTx } from '../questions/service.js';

export { isMastered } from './goals.js';

// ---------- 类型（today 模块依赖的公开契约）----------

/** 一次作答的业务判定结果；tooEasy 仅在 kind='pass' 时有意义（调用方负责折算 guessed/viewedSource） */
export interface ReviewOutcome {
  kind: 'pass' | 'basic_pass' | 'fail';
  tooEasy?: boolean;
}

/** 维度复习状态快照（纯函数进出；时间一律 ISO UTC 字符串） */
export interface ReviewStateSnapshot {
  level: number;
  stable: boolean;
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

/** L0（未激活）没有对应间隔，按 L1 处理（PRODUCT §6.2 阶梯） */
function intervalAt(level: number): number {
  return INTERVALS_DAYS[Math.min(Math.max(level, LEVEL_MIN), LEVEL_MAX) - 1]!;
}

const INACTIVE_SNAPSHOT: ReviewStateSnapshot = {
  level: 0,
  stable: false,
  nextReviewAt: null,
  lastReviewAt: null,
  correctStreak: 0,
  wrongStreak: 0,
};

function toSnapshot(row: typeof reviewStates.$inferSelect): ReviewStateSnapshot {
  return {
    level: row.level,
    stable: row.stable === 1,
    nextReviewAt: row.nextReviewAt,
    lastReviewAt: row.lastReviewAt,
    correctStreak: row.correctStreak,
    wrongStreak: row.wrongStreak,
  };
}

// ---------- 状态机纯函数（PRODUCT_DESIGN §6.2 + Phase 3 确认默认值）----------

/**
 * pass：level+1（封顶 7），next = 新级间隔；L7 到期再 pass → stable（吸收态，不再排期）。
 * basic_pass：level 不变，next = 当前级间隔 × 0.5（min 1 天）。
 * fail：level-1（min 1；L0 输入按 1 处理不降），next = 降级后间隔 × 0.5（min 1 天）。
 * tooEasy（仅 pass）：额外 +1 级，仍封顶 7 / 不提前 stable。
 * streaks：pass 记对；basic_pass 双清零；fail 记错。
 */
export function computeNextReviewState(
  current: ReviewStateSnapshot,
  outcome: ReviewOutcome,
  now: Date,
): ReviewStateSnapshot {
  let level = current.level;
  let stable = current.stable;
  let intervalDays: number;

  if (outcome.kind === 'pass') {
    if (current.stable) {
      // stable 吸收态：保持 L7/stable，不排期
      intervalDays = INTERVALS_DAYS[LEVEL_MAX - 1]!;
    } else {
      const extra = outcome.tooEasy === true ? TOO_EASY_EXTRA_LEVELS : 0;
      level = Math.min(current.level + 1 + extra, LEVEL_MAX);
      stable = current.level >= LEVEL_MAX; // L7 到期再 pass → stable
      intervalDays = INTERVALS_DAYS[level - 1]!;
    }
  } else if (outcome.kind === 'basic_pass') {
    intervalDays = Math.max(
      intervalAt(current.level) * BASIC_PASS_INTERVAL_FACTOR,
      MIN_INTERVAL_DAYS,
    );
  } else {
    level = Math.max(current.level - 1, LEVEL_MIN);
    intervalDays = Math.max(INTERVALS_DAYS[level - 1]! * FAIL_INTERVAL_FACTOR, MIN_INTERVAL_DAYS);
  }

  const correctStreak = outcome.kind === 'pass' ? current.correctStreak + 1 : 0;
  const wrongStreak = outcome.kind === 'fail' ? current.wrongStreak + 1 : 0;

  return {
    level,
    stable,
    nextReviewAt: stable ? null : addDaysIso(now, intervalDays),
    lastReviewAt: now.toISOString(),
    correctStreak,
    wrongStreak,
  };
}

/** Learn 首道理解题答对：U 进入 L1，next=+1d，记一次答对（PRODUCT §6.3） */
export function initialUnderstandingAfterLearn(now: Date): ReviewStateSnapshot {
  return computeNextReviewState(INACTIVE_SNAPSHOT, { kind: 'pass' }, now);
}

/** Production 首次激活：L0、next=+1d（激活但未首答） */
export function initialProductionActivation(now: Date): ReviewStateSnapshot {
  return {
    level: 0,
    stable: false,
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
  if (p && (p.level !== 0 || p.stable !== 0 || p.nextReviewAt !== null || p.lastReviewAt !== null))
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
        level: 0,
        stable: 0,
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
 * 读行 → 纯函数计算 → 写回（含 correct/wrong streak）→ 两维均 stable 则 item.status='mastered'。
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
    level: post.level,
    stable: post.stable ? 1 : 0,
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
