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
  it('行不存在 → pre=null 并创建行', async () => {
    const itemId = await seedReadyItem();
    let pre: unknown;
    let post: unknown;
    db.transaction((tx: DbTx) => {
      ({ pre, post } = advanceReviewState(tx, itemId, 'understanding', { kind: 'pass' }, NOW));
    });
    expect(pre).toBeNull();
    expect(post).toMatchObject({ level: 1, stable: false });

    const row = stateRow(itemId, 'understanding');
    expect(row).not.toBeNull();
    expect(row!.level).toBe(1);
    expect(row!.stable).toBe(0);
    expect(row!.nextReviewAt).toBe(new Date(NOW.getTime() + 86_400_000).toISOString());
    expect(row!.lastReviewAt).toBe(NOW.toISOString());
    expect(row!.correctStreak).toBe(1);
    expect(row!.wrongStreak).toBe(0);
  });

  it('pre 返回原有快照，post 为推进结果并写回', async () => {
    const itemId = await seedReadyItem();
    await seedReviewState(db, itemId, 'understanding', { level: 2 });

    let pre: ReviewStateSnapshot | null | undefined;
    let post: ReviewStateSnapshot | undefined;
    db.transaction((tx: DbTx) => {
      const r = advanceReviewState(tx, itemId, 'understanding', { kind: 'pass' }, NOW);
      pre = r.pre;
      post = r.post;
    });

    expect(pre).toEqual({
      level: 2,
      stable: false,
      nextReviewAt: null,
      lastReviewAt: null,
      correctStreak: 0,
      wrongStreak: 0,
    });
    expect(post!.level).toBe(3);
    expect(stateRow(itemId, 'understanding')!.level).toBe(3);
  });

  it('只修改对应维度，另一维保持不变', async () => {
    const itemId = await seedReadyItem();
    const uNext = '2026-09-25T08:00:00.000Z';
    const pNext = '2026-09-26T08:00:00.000Z';
    await seedReviewState(db, itemId, 'understanding', { level: 3, nextReviewAt: uNext });
    await seedReviewState(db, itemId, 'production', { level: 2, nextReviewAt: pNext });
    const pBefore = stateRow(itemId, 'production')!;

    db.transaction((tx: DbTx) => {
      advanceReviewState(tx, itemId, 'understanding', { kind: 'fail' }, NOW);
    });

    const u = stateRow(itemId, 'understanding')!;
    const p = stateRow(itemId, 'production')!;
    expect(u.level).toBe(2); // fail 降级
    expect(p.level).toBe(2); // 未动
    expect(p.nextReviewAt).toBe(pNext);
    expect(p.updatedAt).toBe(pBefore.updatedAt);
    expect(p.lastReviewAt).toBe(pBefore.lastReviewAt);
  });

  it('两维均 stable → item.status 变 mastered', async () => {
    const itemId = await seedReadyItem();
    await seedReviewState(db, itemId, 'understanding', { level: 7, stable: 1, nextReviewAt: null });
    await seedReviewState(db, itemId, 'production', { level: 7, stable: 0 });

    let post: ReturnType<typeof advanceReviewState>['post'] | undefined;
    db.transaction((tx: DbTx) => {
      post = advanceReviewState(tx, itemId, 'production', { kind: 'pass' }, NOW).post;
    });

    expect(post!.stable).toBe(true);
    expect(itemRow(itemId).status).toBe('mastered');
  });

  it('需造句的 Chunk 只有一维 stable 不触发 mastered', async () => {
    const itemId = await seedReadyItem();
    db.update(learningItems).set({ type: 'chunk' }).where(eq(learningItems.id, itemId)).run();
    await seedReviewState(db, itemId, 'understanding', { level: 7, stable: 1, nextReviewAt: null });
    await seedReviewState(db, itemId, 'production', { level: 3, stable: 0 });

    db.transaction((tx: DbTx) => {
      advanceReviewState(tx, itemId, 'production', { kind: 'pass' }, NOW);
    });

    expect(stateRow(itemId, 'production')!.level).toBe(4);
    expect(itemRow(itemId).status).toBe('active');
  });
});
