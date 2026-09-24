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
  type ReviewDimension,
} from '@el/shared';
import { learningItems, reviewStates } from '../../db/schema.js';
import type { DbExecutor, DbTx } from '../questions/service.js';

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

/** 两维均 stable → Learning Item mastered（PRODUCT §6.2） */
export function isMastered(u: ReviewStateSnapshot, p: ReviewStateSnapshot): boolean {
  return u.stable && p.stable;
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

  // 两维均 stable → Learning Item 自动进入 mastered（PRODUCT §6.2）
  const states = tx
    .select()
    .from(reviewStates)
    .where(eq(reviewStates.learningItemId, itemId))
    .all();
  if (states.length === 2 && states.every((s) => s.stable === 1)) {
    tx.update(learningItems)
      .set({ status: 'mastered', updatedAt: nowIso })
      .where(eq(learningItems.id, itemId))
      .run();
  }

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
  return rows as UpcomingDueEntry[];
}
