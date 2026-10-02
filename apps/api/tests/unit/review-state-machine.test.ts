import { describe, expect, it } from 'vitest';
import { INTERVALS_DAYS } from '@el/shared';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../../src/db/client.js';
import { learningItems, reviewStates } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrate.js';
import { effectiveProductionEnabled } from '../../src/modules/review/goals.js';
import {
  computeNextReviewState,
  initialProductionActivation,
  initialUnderstandingAfterLearn,
  isMastered,
  reconcileItemStatus,
  type ReviewStateSnapshot,
} from '../../src/modules/review/service.js';

const NOW = new Date('2026-09-24T08:00:00.000Z');

function plusDays(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

function snap(overrides: Partial<ReviewStateSnapshot> = {}): ReviewStateSnapshot {
  return {
    level: 1,
    stable: false,
    nextReviewAt: plusDays(-1),
    lastReviewAt: plusDays(-1),
    correctStreak: 0,
    wrongStreak: 0,
    ...overrides,
  };
}

describe('computeNextReviewState：pass', () => {
  it('pass 从 L1 开始全级别序列 L1→…→L7→stable，next_review_at 按 ISO 正确计算', () => {
    let state = initialUnderstandingAfterLearn(NOW);
    expect(state.level).toBe(1);
    expect(state.nextReviewAt).toBe(plusDays(1));

    for (let level = 2; level <= 7; level++) {
      state = computeNextReviewState(state, { kind: 'pass' }, NOW);
      expect(state.level).toBe(level);
      expect(state.stable).toBe(false);
      expect(state.nextReviewAt).toBe(plusDays(INTERVALS_DAYS[level - 1]!));
      expect(state.lastReviewAt).toBe(NOW.toISOString());
    }

    // L7 到期再 pass → stable
    state = computeNextReviewState(state, { kind: 'pass' }, NOW);
    expect(state.level).toBe(7);
    expect(state.stable).toBe(true);
    expect(state.nextReviewAt).toBeNull();
    expect(state.lastReviewAt).toBe(NOW.toISOString());
  });

  it('pass 升 1 级并按新级别间隔调度（L1→L2 = +3 天）', () => {
    const out = computeNextReviewState(snap({ level: 1 }), { kind: 'pass' }, NOW);
    expect(out.level).toBe(2);
    expect(out.nextReviewAt).toBe(plusDays(3));
    expect(out.stable).toBe(false);
  });

  it('L0（未激活）输入 pass → 进入 L1，next=+1 天', () => {
    const out = computeNextReviewState(
      snap({ level: 0, nextReviewAt: null, lastReviewAt: null }),
      { kind: 'pass' },
      NOW,
    );
    expect(out.level).toBe(1);
    expect(out.nextReviewAt).toBe(plusDays(1));
  });

  it('tooEasy 在 pass 基础上额外 +1 级', () => {
    const out = computeNextReviewState(snap({ level: 1 }), { kind: 'pass', tooEasy: true }, NOW);
    expect(out.level).toBe(3);
    expect(out.nextReviewAt).toBe(plusDays(INTERVALS_DAYS[2]!));
  });

  it('tooEasy 从 L6 封顶 L7 但不提前 stable', () => {
    const out = computeNextReviewState(snap({ level: 6 }), { kind: 'pass', tooEasy: true }, NOW);
    expect(out.level).toBe(7);
    expect(out.stable).toBe(false);
    expect(out.nextReviewAt).toBe(plusDays(INTERVALS_DAYS[6]!));
  });

  it('tooEasy 在 L7 → stable', () => {
    const out = computeNextReviewState(snap({ level: 7 }), { kind: 'pass', tooEasy: true }, NOW);
    expect(out.level).toBe(7);
    expect(out.stable).toBe(true);
    expect(out.nextReviewAt).toBeNull();
  });

  it('stable 是吸收态：再 pass 保持 stable 且不排期', () => {
    const out = computeNextReviewState(
      snap({ level: 7, stable: true, nextReviewAt: null }),
      { kind: 'pass' },
      NOW,
    );
    expect(out.stable).toBe(true);
    expect(out.level).toBe(7);
    expect(out.nextReviewAt).toBeNull();
  });
});

describe('computeNextReviewState：basic_pass', () => {
  it.each([1, 2, 3, 7])('basic_pass L%d 不升级，间隔 = 当前级间隔 × 0.5（min 1 天）', (level) => {
    const out = computeNextReviewState(snap({ level }), { kind: 'basic_pass' }, NOW);
    expect(out.level).toBe(level);
    expect(out.stable).toBe(false);
    const expected = Math.max(INTERVALS_DAYS[level - 1]! * 0.5, 1);
    expect(out.nextReviewAt).toBe(plusDays(expected));
  });

  it('basic_pass L1 的 0.5 天被抬到 1 天', () => {
    const out = computeNextReviewState(snap({ level: 1 }), { kind: 'basic_pass' }, NOW);
    expect(out.nextReviewAt).toBe(plusDays(1));
  });

  it('basic_pass L7 → 120 × 0.5 = 60 天', () => {
    const out = computeNextReviewState(snap({ level: 7 }), { kind: 'basic_pass' }, NOW);
    expect(out.nextReviewAt).toBe(plusDays(60));
    expect(out.stable).toBe(false);
  });
});

describe('computeNextReviewState：fail', () => {
  it('fail 降 1 级并按降级后间隔 × 0.5 排期（L3→L2 = +1.5 天）', () => {
    const out = computeNextReviewState(snap({ level: 3 }), { kind: 'fail' }, NOW);
    expect(out.level).toBe(2);
    expect(out.nextReviewAt).toBe(plusDays(INTERVALS_DAYS[1]! * 0.5));
  });

  it('fail 在 L1 不再降级，间隔抬到 1 天', () => {
    const out = computeNextReviewState(snap({ level: 1 }), { kind: 'fail' }, NOW);
    expect(out.level).toBe(1);
    expect(out.nextReviewAt).toBe(plusDays(1));
  });

  it('fail 的 L0 输入按 1 处理不降（结果 L1）', () => {
    const out = computeNextReviewState(
      snap({ level: 0, nextReviewAt: null, lastReviewAt: null }),
      { kind: 'fail' },
      NOW,
    );
    expect(out.level).toBe(1);
    expect(out.nextReviewAt).toBe(plusDays(1));
  });

  it('fail 在 L7 降到 L6，间隔 = L6 间隔 × 0.5 = 30 天', () => {
    const out = computeNextReviewState(snap({ level: 7 }), { kind: 'fail' }, NOW);
    expect(out.level).toBe(6);
    expect(out.nextReviewAt).toBe(plusDays(INTERVALS_DAYS[5]! * 0.5));
    expect(out.nextReviewAt).toBe(plusDays(30));
  });
});

describe('computeNextReviewState：streaks', () => {
  it('pass：correctStreak+1、wrongStreak 清零', () => {
    const out = computeNextReviewState(
      snap({ correctStreak: 2, wrongStreak: 3 }),
      { kind: 'pass' },
      NOW,
    );
    expect(out.correctStreak).toBe(3);
    expect(out.wrongStreak).toBe(0);
  });

  it('basic_pass：双 streak 清零', () => {
    const out = computeNextReviewState(
      snap({ correctStreak: 3, wrongStreak: 2 }),
      { kind: 'basic_pass' },
      NOW,
    );
    expect(out.correctStreak).toBe(0);
    expect(out.wrongStreak).toBe(0);
  });

  it('fail：wrongStreak+1、correctStreak 清零', () => {
    const out = computeNextReviewState(
      snap({ correctStreak: 2, wrongStreak: 1 }),
      { kind: 'fail' },
      NOW,
    );
    expect(out.correctStreak).toBe(0);
    expect(out.wrongStreak).toBe(2);
  });
});

describe('初始状态与 mastered 判定', () => {
  it('initialUnderstandingAfterLearn：L1、next=+1d、记一次答对', () => {
    const out = initialUnderstandingAfterLearn(NOW);
    expect(out).toEqual({
      level: 1,
      stable: false,
      nextReviewAt: plusDays(1),
      lastReviewAt: NOW.toISOString(),
      correctStreak: 1,
      wrongStreak: 0,
    });
  });

  it('initialProductionActivation：L0、next=+1d、激活但未首答', () => {
    const out = initialProductionActivation(NOW);
    expect(out).toEqual({
      level: 0,
      stable: false,
      nextReviewAt: plusDays(1),
      lastReviewAt: null,
      correctStreak: 0,
      wrongStreak: 0,
    });
  });

  it('isMastered：只按当前有效目标要求稳定维度', () => {
    const stable = snap({ level: 7, stable: true, nextReviewAt: null });
    const notStable = snap({ level: 7, stable: false });
    expect(isMastered(stable, stable, true)).toBe(true);
    expect(isMastered(notStable, stable, true)).toBe(false);
    expect(isMastered(stable, notStable, true)).toBe(false);
    expect(isMastered(notStable, notStable, true)).toBe(false);
    expect(isMastered(stable, notStable, false)).toBe(true);
    expect(isMastered(notStable, stable, false)).toBe(false);
  });

  it('effectiveProductionEnabled：Word 默认关、Chunk 默认开，显式覆盖优先', () => {
    expect(effectiveProductionEnabled({ type: 'word', productionEnabledOverride: null })).toBe(
      false,
    );
    expect(effectiveProductionEnabled({ type: 'chunk', productionEnabledOverride: null })).toBe(
      true,
    );
    expect(effectiveProductionEnabled({ type: 'word', productionEnabledOverride: 1 })).toBe(true);
    expect(effectiveProductionEnabled({ type: 'chunk', productionEnabledOverride: 0 })).toBe(false);
  });

  it('reconcileItemStatus：目标改变时重算 active/mastered，但不恢复 paused/archived', () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    const now = NOW.toISOString();
    for (const [id, status] of [
      ['word', 'active'],
      ['chunk', 'mastered'],
      ['paused', 'paused'],
      ['archived', 'archived'],
    ] as const) {
      db.insert(learningItems)
        .values({
          id,
          type: id === 'word' ? 'word' : 'chunk',
          target: id,
          meaning: id,
          status,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(reviewStates)
        .values({
          id: `${id}-u`,
          learningItemId: id,
          dimension: 'understanding',
          level: 7,
          stable: 1,
          updatedAt: now,
        })
        .run();
      db.insert(reviewStates)
        .values({
          id: `${id}-p`,
          learningItemId: id,
          dimension: 'production',
          level: 1,
          stable: 0,
          updatedAt: now,
        })
        .run();
    }
    db.transaction((tx) => {
      for (const id of ['word', 'chunk', 'paused', 'archived']) reconcileItemStatus(tx, id, now);
    });
    expect(
      db.select({ id: learningItems.id, status: learningItems.status }).from(learningItems).all(),
    ).toEqual([
      { id: 'word', status: 'mastered' },
      { id: 'chunk', status: 'active' },
      { id: 'paused', status: 'paused' },
      { id: 'archived', status: 'archived' },
    ]);
    db.update(learningItems)
      .set({ productionEnabledOverride: 0 })
      .where(eq(learningItems.id, 'chunk'))
      .run();
    db.transaction((tx) => reconcileItemStatus(tx, 'chunk', now));
    expect(
      db
        .select({ status: learningItems.status })
        .from(learningItems)
        .where(eq(learningItems.id, 'chunk'))
        .get()?.status,
    ).toBe('mastered');
  });
});
