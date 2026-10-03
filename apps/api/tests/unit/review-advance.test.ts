import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { learningItems, reviewStates } from '../../src/db/schema.js';
import type { DbTx } from '../../src/modules/questions/service.js';
import { advanceReviewState, type ReviewStateSnapshot } from '../../src/modules/review/service.js';
import { seedExample, seedItem, seedReviewState } from '../helpers/seed.js';

let db: AppDatabase;
const NOW = new Date('2026-09-24T08:00:00.000Z');

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

function stateRow(itemId: string, dimension: 'understanding' | 'production') {
  return (
    db
      .select()
      .from(reviewStates)
      .where(and(eq(reviewStates.learningItemId, itemId), eq(reviewStates.dimension, dimension)))
      .get() ?? null
  );
}

function itemRow(itemId: string) {
  return db.select().from(learningItems).where(eq(learningItems.id, itemId)).get()!;
}

async function seedReadyItem(): Promise<string> {
  const itemId = await seedItem(db, { status: 'active', queueState: 'started' });
  await seedExample(db, itemId, 'source', 'Long-term stress wears you down.');
  return itemId;
}

describe('advanceReviewState', () => {
  it('行不存在 → pre=null 并创建行（未激活 + Good 建卡）', async () => {
    const itemId = await seedReadyItem();
    let pre: unknown;
    let post: unknown;
    db.transaction((tx: DbTx) => {
      ({ pre, post } = advanceReviewState(tx, itemId, 'understanding', { kind: 'pass' }, NOW));
    });
    expect(pre).toBeNull();
    expect(post).toMatchObject({ reps: 1, lapses: 0, correctStreak: 1 });

    const row = stateRow(itemId, 'understanding');
    expect(row).not.toBeNull();
    expect(row!.difficulty).not.toBeNull();
    expect(row!.stability).toBeGreaterThan(0);
    expect(row!.reps).toBe(1);
    expect(Date.parse(row!.nextReviewAt!) - NOW.getTime()).toBeGreaterThanOrEqual(86_400_000);
    expect(row!.lastReviewAt).toBe(NOW.toISOString());
    expect(row!.correctStreak).toBe(1);
    expect(row!.wrongStreak).toBe(0);
  });

  it('pre 返回原有快照，post 为推进结果并写回', async () => {
    const itemId = await seedReadyItem();
    await seedReviewState(db, itemId, 'understanding', {
      difficulty: 5,
      stability: 5,
      reps: 2,
      lastReviewAt: '2026-09-20T00:00:00.000Z',
    });

    let pre: ReviewStateSnapshot | null | undefined;
    let post: ReviewStateSnapshot | undefined;
    db.transaction((tx: DbTx) => {
      const r = advanceReviewState(tx, itemId, 'understanding', { kind: 'pass' }, NOW);
      pre = r.pre;
      post = r.post;
    });

    expect(pre).toEqual({
      difficulty: 5,
      stability: 5,
      reps: 2,
      lapses: 0,
      nextReviewAt: null,
      lastReviewAt: '2026-09-20T00:00:00.000Z',
      correctStreak: 0,
      wrongStreak: 0,
    });
    expect(post!.reps).toBe(3);
    expect(stateRow(itemId, 'understanding')!.reps).toBe(3);
  });

  it('只修改对应维度，另一维保持不变', async () => {
    const itemId = await seedReadyItem();
    const uNext = '2026-09-25T08:00:00.000Z';
    const pNext = '2026-09-26T08:00:00.000Z';
    await seedReviewState(db, itemId, 'understanding', {
      difficulty: 5,
      stability: 15,
      reps: 3,
      nextReviewAt: uNext,
      lastReviewAt: '2026-09-20T00:00:00.000Z',
    });
    await seedReviewState(db, itemId, 'production', {
      difficulty: 5,
      stability: 5,
      reps: 2,
      nextReviewAt: pNext,
      lastReviewAt: '2026-09-20T00:00:00.000Z',
    });
    const pBefore = stateRow(itemId, 'production')!;

    db.transaction((tx: DbTx) => {
      advanceReviewState(tx, itemId, 'understanding', { kind: 'fail' }, NOW);
    });

    const u = stateRow(itemId, 'understanding')!;
    const p = stateRow(itemId, 'production')!;
    expect(u.lapses).toBe(1); // fail 记错
    expect(u.stability!).toBeLessThan(15);
    expect(p.reps).toBe(2); // 未动
    expect(p.nextReviewAt).toBe(pNext);
    expect(p.updatedAt).toBe(pBefore.updatedAt);
    expect(p.lastReviewAt).toBe(pBefore.lastReviewAt);
  });

  it('两维均越过掌握线 → item.status 变 mastered', async () => {
    const itemId = await seedReadyItem();
    await seedReviewState(db, itemId, 'understanding', {
      difficulty: 5,
      stability: 130,
      reps: 8,
      nextReviewAt: null,
    });
    await seedReviewState(db, itemId, 'production', {
      difficulty: 5,
      stability: 118,
      reps: 7,
      nextReviewAt: '2026-09-23T00:00:00.000Z',
      lastReviewAt: '2026-09-20T00:00:00.000Z',
    });

    let post: ReturnType<typeof advanceReviewState>['post'] | undefined;
    db.transaction((tx: DbTx) => {
      post = advanceReviewState(tx, itemId, 'production', { kind: 'pass' }, NOW).post;
    });

    expect(post!.stability!).toBeGreaterThanOrEqual(120);
    expect(itemRow(itemId).status).toBe('mastered');
  });

  it('需造句的 Chunk 只有一维越过掌握线不触发 mastered', async () => {
    const itemId = await seedReadyItem();
    db.update(learningItems).set({ type: 'chunk' }).where(eq(learningItems.id, itemId)).run();
    await seedReviewState(db, itemId, 'understanding', {
      difficulty: 5,
      stability: 130,
      reps: 8,
      nextReviewAt: null,
    });
    await seedReviewState(db, itemId, 'production', {
      difficulty: 5,
      stability: 15,
      reps: 3,
      nextReviewAt: '2026-09-23T00:00:00.000Z',
      lastReviewAt: '2026-09-20T00:00:00.000Z',
    });

    db.transaction((tx: DbTx) => {
      advanceReviewState(tx, itemId, 'production', { kind: 'pass' }, NOW);
    });

    expect(stateRow(itemId, 'production')!.stability!).toBeLessThan(120);
    expect(itemRow(itemId).status).toBe('active');
  });
});
