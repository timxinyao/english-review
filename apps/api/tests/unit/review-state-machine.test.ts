import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { stabilityStageLabel } from '@el/shared';
import { createDatabase } from '../../src/db/client.js';
import { learningItems, reviewStates } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrate.js';
import { effectiveProductionEnabled } from '../../src/modules/review/goals.js';
import {
  INACTIVE_SNAPSHOT,
  computeNextReviewState,
  initialProductionActivation,
  initialUnderstandingAfterLearn,
  isMastered,
  reconcileItemStatus,
  type ReviewStateSnapshot,
} from '../../src/modules/review/service.js';

const NOW = new Date('2026-10-03T00:00:00.000Z');
const DAY_MS = 86_400_000;

function plusDays(days: number): string {
  return new Date(NOW.getTime() + days * DAY_MS).toISOString();
}

function snap(overrides: Partial<ReviewStateSnapshot> = {}): ReviewStateSnapshot {
  return {
    difficulty: 5,
    stability: 15,
    reps: 3,
    lapses: 0,
    nextReviewAt: plusDays(-1),
    lastReviewAt: plusDays(-1),
    correctStreak: 0,
    wrongStreak: 0,
    ...overrides,
  };
}

describe('computeNextReviewState（FSRS）', () => {
  it('未激活输入 + Good：激活并排期 ≥1 天；Easy 间隔 > Good；Again 最短', () => {
    const inactive = INACTIVE_SNAPSHOT;
    const good = computeNextReviewState(inactive, { kind: 'pass' }, NOW);
    const easy = computeNextReviewState(inactive, { kind: 'pass', tooEasy: true }, NOW);
    const again = computeNextReviewState(inactive, { kind: 'fail' }, NOW);
    expect(Date.parse(good.nextReviewAt!) - NOW.getTime()).toBeGreaterThanOrEqual(DAY_MS);
    expect(Date.parse(easy.nextReviewAt!)).toBeGreaterThan(Date.parse(good.nextReviewAt!));
    expect(Date.parse(again.nextReviewAt!)).toBeLessThan(Date.parse(good.nextReviewAt!));
    expect(good.stability).toBeGreaterThanOrEqual(0);
  });

  it('未激活 + basic_pass（Hard）：同样激活，间隔介于 Again 与 Good 之间', () => {
    const hard = computeNextReviewState(INACTIVE_SNAPSHOT, { kind: 'basic_pass' }, NOW);
    const good = computeNextReviewState(INACTIVE_SNAPSHOT, { kind: 'pass' }, NOW);
    const again = computeNextReviewState(INACTIVE_SNAPSHOT, { kind: 'fail' }, NOW);
    expect(hard.difficulty).not.toBeNull();
    expect(Date.parse(hard.nextReviewAt!)).toBeGreaterThan(Date.parse(again.nextReviewAt!));
    expect(Date.parse(hard.nextReviewAt!)).toBeLessThan(Date.parse(good.nextReviewAt!));
  });

  it('连续 Good：stability 单调增、间隔递增、reps 累计；fail 后 lapses+1', () => {
    const s = computeNextReviewState(INACTIVE_SNAPSHOT, { kind: 'pass' }, NOW);
    expect(s.reps).toBe(1);
    const s2 = computeNextReviewState(s, { kind: 'pass' }, new Date(NOW.getTime() + 3 * DAY_MS));
    expect(s2.stability!).toBeGreaterThan(s.stability!);
    expect(s2.reps).toBe(s.reps + 1);
    expect(Date.parse(s2.nextReviewAt!)).toBeGreaterThan(Date.parse(s.nextReviewAt!));
    const s3 = computeNextReviewState(s2, { kind: 'fail' }, new Date(NOW.getTime() + 4 * DAY_MS));
    expect(s3.lapses).toBe(s2.lapses + 1);
    expect(s3.wrongStreak).toBe(1);
    expect(s3.correctStreak).toBe(0);
  });

  it('stability 增长后间隔封顶 365 天；S≥120（mastered）仍照常排期（无 null 吸收态）', () => {
    let s = computeNextReviewState(INACTIVE_SNAPSHOT, { kind: 'pass' }, NOW);
    for (let i = 2; i <= 6; i++) {
      s = computeNextReviewState(s, { kind: 'pass' }, new Date(Date.parse(s.nextReviewAt!)));
      expect(Date.parse(s.nextReviewAt!) - Date.parse(s.lastReviewAt!)).toBeLessThanOrEqual(
        365 * DAY_MS + 1000,
      );
    }
    expect(s.stability!).toBeGreaterThanOrEqual(120); // Good×6 已越过掌握线
    expect(s.nextReviewAt).not.toBeNull(); // 掌握后不再有「不排期」状态
  });

  it('tooEasy（Easy 评分）比同起点 pass 间隔更长', () => {
    const base = snap();
    const pass = computeNextReviewState(base, { kind: 'pass' }, NOW);
    const easy = computeNextReviewState(base, { kind: 'pass', tooEasy: true }, NOW);
    expect(Date.parse(easy.nextReviewAt!)).toBeGreaterThan(Date.parse(pass.nextReviewAt!));
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
  it('initialUnderstandingAfterLearn：learn 首答即首评分，按 outcome 建 U', () => {
    const pass = initialUnderstandingAfterLearn({ kind: 'pass' }, NOW);
    expect(pass.difficulty).not.toBeNull();
    expect(pass.stability).toBeGreaterThan(0);
    expect(pass.reps).toBe(1);
    expect(pass.lapses).toBe(0);
    expect(pass.lastReviewAt).toBe(NOW.toISOString());
    expect(Date.parse(pass.nextReviewAt!) - NOW.getTime()).toBeGreaterThanOrEqual(DAY_MS);
    expect(pass.correctStreak).toBe(1);

    const easy = initialUnderstandingAfterLearn({ kind: 'pass', tooEasy: true }, NOW);
    expect(Date.parse(easy.nextReviewAt!)).toBeGreaterThan(Date.parse(pass.nextReviewAt!));

    const fail = initialUnderstandingAfterLearn({ kind: 'fail' }, NOW);
    expect(fail.wrongStreak).toBe(1);
    expect(Date.parse(fail.nextReviewAt!) - NOW.getTime()).toBeGreaterThanOrEqual(DAY_MS);
  });

  it('initialProductionActivation：D/S 未激活、reps/lapses=0、next=+1d、未首答', () => {
    const out = initialProductionActivation(NOW);
    expect(out).toEqual({
      difficulty: null,
      stability: null,
      reps: 0,
      lapses: 0,
      nextReviewAt: plusDays(1),
      lastReviewAt: null,
      correctStreak: 0,
      wrongStreak: 0,
    });
  });

  it('mastered 谓词：U/P 均 S≥120 且目标开 → mastered；S<120 不 master', () => {
    const mk = (stability: number): ReviewStateSnapshot => ({
      difficulty: 5,
      stability,
      reps: 5,
      lapses: 0,
      nextReviewAt: '2027-01-01T00:00:00.000Z',
      lastReviewAt: '2026-10-01T00:00:00.000Z',
      correctStreak: 5,
      wrongStreak: 0,
    });
    expect(isMastered(mk(130), mk(130), true)).toBe(true);
    expect(isMastered(mk(130), mk(60), true)).toBe(false);
    expect(isMastered(mk(60), mk(130), true)).toBe(false);
    expect(isMastered(mk(130), mk(0), false)).toBe(true); // P 不要求
    expect(isMastered(mk(119.9), mk(130), false)).toBe(false); // 阈值含等号
    expect(isMastered(INACTIVE_SNAPSHOT, INACTIVE_SNAPSHOT, false)).toBe(false);
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

  it('边界断言：isMastered 恰 S=120 为 true、119.99 为 false（等号归属掌握侧）', () => {
    const mk = (stability: number): ReviewStateSnapshot => ({
      difficulty: 5,
      stability,
      reps: 5,
      lapses: 0,
      nextReviewAt: '2027-01-01T00:00:00.000Z',
      lastReviewAt: '2026-10-01T00:00:00.000Z',
      correctStreak: 5,
      wrongStreak: 0,
    });
    expect(isMastered(mk(120), mk(120), true)).toBe(true);
    expect(isMastered(mk(119.99), mk(120), true)).toBe(false);
    expect(isMastered(mk(120), mk(119.99), true)).toBe(false);
    // 目标关闭时只看 U：P 未过线不影响
    expect(isMastered(mk(120), mk(119.99), false)).toBe(true);
  });

  it('边界断言：stabilityStageLabel 的 7/30/120 等号归属下一档', () => {
    expect(stabilityStageLabel(null)).toBe('未开始');
    expect(stabilityStageLabel(0.5)).toBe('新');
    expect(stabilityStageLabel(6.99)).toBe('新');
    expect(stabilityStageLabel(7)).toBe('巩固'); // 7 恰好归「巩固」
    expect(stabilityStageLabel(29.99)).toBe('巩固');
    expect(stabilityStageLabel(30)).toBe('熟练'); // 30 恰好归「熟练」
    expect(stabilityStageLabel(119.99)).toBe('熟练');
    expect(stabilityStageLabel(120)).toBe('掌握'); // 120 恰好归「掌握」（与 isMastered 同线）
    expect(stabilityStageLabel(365)).toBe('掌握');
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
          difficulty: 5,
          stability: 130,
          reps: 8,
          updatedAt: now,
        })
        .run();
      db.insert(reviewStates)
        .values({
          id: `${id}-p`,
          learningItemId: id,
          dimension: 'production',
          difficulty: 5,
          stability: 5,
          reps: 1,
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
      { id: 'word', status: 'mastered' }, // word P 默认关闭 → 只看 U
      { id: 'chunk', status: 'active' }, // chunk P 开启且 S=5 <120 → 不掌握
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
