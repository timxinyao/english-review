import { describe, expect, it } from 'vitest';
import { Rating } from 'ts-fsrs';
import {
  advanceCard,
  cardFromSnapshot,
  newCard,
  ratingOf,
  replayRatings,
  type FsrStateFields,
} from '../../src/modules/review/fsrs-engine.js';

const T0 = new Date('2026-10-03T00:00:00.000Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);

describe('ratingOf（ReviewOutcome → FSRS Rating）', () => {
  it('fail→Again / basic_pass→Hard / pass→Good / pass+tooEasy→Easy', () => {
    expect(ratingOf({ kind: 'fail' })).toBe(Rating.Again);
    expect(ratingOf({ kind: 'basic_pass' })).toBe(Rating.Hard);
    expect(ratingOf({ kind: 'pass' })).toBe(Rating.Good);
    expect(ratingOf({ kind: 'pass', tooEasy: true })).toBe(Rating.Easy);
  });
});

describe('advanceCard（含 1..365 天 clamp）', () => {
  it('Good：间隔 ≥1 天；Easy > Good；Again 最短且下限 1 天', () => {
    const c0 = newCard(T0);
    const good = advanceCard(c0, T0, Rating.Good);
    const easy = advanceCard(c0, T0, Rating.Easy);
    const again = advanceCard(c0, T0, Rating.Again);
    const d = (c: ReturnType<typeof newCard>) => (c.due.getTime() - T0.getTime()) / DAY;
    expect(d(good)).toBeGreaterThanOrEqual(1);
    expect(d(easy)).toBeGreaterThan(d(good));
    expect(d(again)).toBeLessThan(d(good));
    expect(d(again)).toBeGreaterThanOrEqual(1);
  });

  it('连续 Good：due 单调向前且 stability 单调不减', () => {
    let card = newCard(T0);
    let prevDue = T0.getTime();
    for (let i = 1; i <= 8; i++) {
      card = advanceCard(card, at(i * 30), Rating.Good);
      expect(card.due.getTime()).toBeGreaterThan(prevDue);
      prevDue = card.due.getTime();
    }
    expect(card.stability).toBeGreaterThan(newCard(T0).stability);
  });
});

describe('cardFromSnapshot / replayRatings', () => {
  it('快照字段重建 Card 后再演进，与连续演进结果一致（同间隔同评分）', () => {
    const c1 = advanceCard(newCard(T0), T0, Rating.Good);
    const fields: FsrStateFields = {
      difficulty: c1.difficulty,
      stability: c1.stability,
      reps: c1.reps,
      lapses: c1.lapses,
      nextReviewAt: c1.due.toISOString(),
      lastReviewAt: T0.toISOString(),
    };
    const rebuilt = cardFromSnapshot(fields, at(7));
    const a = advanceCard(rebuilt, at(7), Rating.Good);

    let direct = c1;
    direct = advanceCard(direct, at(7), Rating.Good);
    expect(a.stability).toBeCloseTo(direct.stability, 6);
    expect(a.due.toISOString()).toBe(direct.due.toISOString());
  });

  it('replayRatings 按时间序回放；空序列=New 状态', () => {
    const card = replayRatings([
      { at: T0, rating: Rating.Good },
      { at: at(3), rating: Rating.Good },
      { at: at(10), rating: Rating.Again },
      { at: at(11), rating: Rating.Good },
    ]);
    expect(card.reps).toBe(4);
    expect(card.lapses).toBe(1);
    expect(replayRatings([]).reps).toBe(0);
  });
});
