import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, rawSqlite } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  appMetadata,
  attempts,
  dailyStats,
  learningExamples,
  learningItems,
  reviewStates,
} from '../../src/db/schema.js';
import { applyV2Cutover } from '../../src/modules/review/v2-cutover.js';
import { seedExample, seedItem, seedReviewState } from '../helpers/seed.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const OLD_DUE = '2026-10-20T00:00:00.000Z';

function production(db: ReturnType<typeof createDatabase>, itemId: string) {
  return db
    .select()
    .from(reviewStates)
    .where(eq(reviewStates.learningItemId, itemId))
    .all()
    .find((state) => state.dimension === 'production');
}

function state(db: ReturnType<typeof createDatabase>, itemId: string, dimension: string) {
  return db
    .select()
    .from(reviewStates)
    .where(eq(reviewStates.learningItemId, itemId))
    .all()
    .find((row) => row.dimension === dimension);
}

describe('Foxi V2 cutover', () => {
  it('resets old P for all rows, makes only started effective-P items due, and preserves U/history/stats', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    const chunk = await seedItem(db, {
      type: 'chunk',
      target: 'wear down',
      needsReinforcement: 1,
    });
    const word = await seedItem(db, { type: 'word', target: 'resilience', needsReinforcement: 1 });
    const optedInWord = await seedItem(db, {
      type: 'word',
      target: 'exhausted',
      productionEnabledOverride: 1,
      status: 'mastered',
    });
    const optedOutChunk = await seedItem(db, {
      type: 'chunk',
      target: 'out of sorts',
      productionEnabledOverride: 0,
      needsReinforcement: 1,
    });
    const newChunk = await seedItem(db, {
      type: 'chunk',
      target: 'keep up',
      queueState: 'new',
      needsReinforcement: 1,
    });
    const paused = await seedItem(db, {
      type: 'chunk',
      target: 'burn out',
      status: 'paused',
      needsReinforcement: 1,
    });
    const archived = await seedItem(db, {
      type: 'chunk',
      target: 'let down',
      status: 'archived',
      needsReinforcement: 1,
    });
    const all = [chunk, word, optedInWord, optedOutChunk, newChunk, paused, archived];
    for (const id of all) {
      await seedReviewState(db, id, 'understanding', {
        difficulty: 5,
        stability: id === optedInWord || id === word ? 130 : 20,
        reps: 4,
        nextReviewAt: OLD_DUE,
        lastReviewAt: '2026-09-25T00:00:00.000Z',
        correctStreak: 3,
      });
      await seedReviewState(db, id, 'production', {
        difficulty: 5,
        stability: id === optedInWord ? 130 : 25,
        reps: 5,
        nextReviewAt: OLD_DUE,
        lastReviewAt: '2026-09-24T00:00:00.000Z',
        correctStreak: 4,
        wrongStreak: 2,
      });
    }
    const exampleId = await seedExample(db, chunk, 'personal', 'Stress wears me down.', {
      pinned: 1,
    });
    db.insert(attempts)
      .values({
        id: 'old-attempt',
        learningItemId: chunk,
        mode: 'today',
        result: 'pass',
        createdAt: '2026-09-25T00:00:00.000Z',
      })
      .run();
    db.insert(dailyStats)
      .values({
        date: '2026-09-25',
        formalTasksCompleted: 7,
        newItemsStarted: 1,
        productionAttempts: 3,
        productionPass: 2,
        updatedAt: '2026-09-25T00:00:00.000Z',
      })
      .run();
    const uBefore = db
      .select()
      .from(reviewStates)
      .all()
      .filter((row) => row.dimension === 'understanding');
    const attemptsBefore = db.select().from(attempts).all();
    const statsBefore = db.select().from(dailyStats).all();

    expect(applyV2Cutover(db, NOW, 'Asia/Shanghai')).toEqual({ applied: true });
    expect(db.select().from(appMetadata).where(eq(appMetadata.key, 'foxi_v2')).get()).toMatchObject(
      {
        key: 'foxi_v2',
      },
    );
    for (const id of all) {
      expect(production(db, id)).toMatchObject({
        difficulty: null,
        stability: null,
        reps: 0,
        lapses: 0,
        nextReviewAt: id === chunk || id === optedInWord ? NOW.toISOString() : null,
        lastReviewAt: null,
        correctStreak: 0,
        wrongStreak: 0,
      });
      expect(
        db.select().from(learningItems).where(eq(learningItems.id, id)).get()?.needsReinforcement,
      ).toBe(0);
    }
    expect(state(db, word, 'understanding')).toMatchObject({ stability: 130, reps: 4 });
    expect(db.select().from(learningItems).where(eq(learningItems.id, word)).get()?.status).toBe(
      'mastered',
    );
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, optedInWord)).get()?.status,
    ).toBe('active');
    expect(db.select().from(learningItems).where(eq(learningItems.id, paused)).get()?.status).toBe(
      'paused',
    );
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, archived)).get()?.status,
    ).toBe('archived');
    expect(
      db
        .select()
        .from(reviewStates)
        .all()
        .filter((row) => row.dimension === 'understanding'),
    ).toEqual(uBefore);
    expect(db.select().from(attempts).all()).toEqual(attemptsBefore);
    expect(
      db.select().from(learningExamples).where(eq(learningExamples.id, exampleId)).get()?.pinned,
    ).toBe(1);
    expect(db.select().from(dailyStats).all()).toEqual(statsBefore);

    const afterFirstRun = rawSqlite(db).serialize();
    expect(applyV2Cutover(db, new Date('2026-10-02T00:00:00.000Z'), 'Asia/Shanghai')).toEqual({
      applied: false,
    });
    expect(rawSqlite(db).serialize()).toEqual(afterFirstRun);
  });

  it('creates an immediately due inactive P row when a started effective-P item has no old P row', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    const itemId = await seedItem(db, { type: 'chunk' });
    await seedReviewState(db, itemId, 'understanding', { stability: 5, reps: 2 });

    expect(applyV2Cutover(db, NOW, 'Asia/Shanghai')).toEqual({ applied: true });
    expect(production(db, itemId)).toMatchObject({
      difficulty: null,
      stability: null,
      reps: 0,
      nextReviewAt: NOW.toISOString(),
      lastReviewAt: null,
    });
  });
});
