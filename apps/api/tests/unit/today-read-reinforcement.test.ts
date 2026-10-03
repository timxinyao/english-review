import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { learningItems, reviewSessions, reviewTasks } from '../../src/db/schema.js';
import {
  getSessionTasks,
  prepareTodayTask,
  startTodaySession,
} from '../../src/modules/today/service.js';
import { seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';
import { choicePayload, createFakeDeps, DEFAULT_OPTIONS } from '../helpers/today-fakes.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-09-24T02:00:00.000Z');
let db: AppDatabase;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

async function seedFlaggedItem(itemId: string, due: boolean): Promise<void> {
  await seedItem(db, { id: itemId, queueState: 'started', needsReinforcement: 1 });
  await seedReviewState(db, itemId, 'understanding', {
    difficulty: 5,
    stability: 15,
    reps: 3,
    nextReviewAt: due ? '2026-09-23T00:00:00.000Z' : '2026-10-01T00:00:00.000Z',
  });
  await seedQuestion(db, itemId, {
    type: 'understanding',
    payloadJson: choicePayload(DEFAULT_OPTIONS),
    correctOptionId: 'o1',
  });
}

describe('V2 Today ignores legacy Read reinforcement flags', () => {
  it('flagged due item receives one ordinary pending Recall task, not a Read task', async () => {
    await seedFlaggedItem('flagged-due', true);
    const started = await startTodaySession(db, createFakeDeps(), TZ, NOW);
    if (started.status !== 'active') throw new Error('expected active');
    expect(started.progress).toEqual({ completed: 0, total: 1 });
    const tasks = db.select().from(reviewTasks).all();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ origin: 'base', taskType: 'understanding', questionId: null });
    const prepared = await prepareTodayTask(db, createFakeDeps(), TZ, NOW, tasks[0]!.id);
    expect(prepared.question?.questionId).toBeTruthy();
  });

  it('flagged non-due item creates no new Today task', async () => {
    await seedFlaggedItem('flagged-later', false);
    const started = await startTodaySession(db, createFakeDeps(), TZ, NOW);
    expect(started.status).toBe('completed');
    expect(db.select().from(reviewTasks).all()).toHaveLength(0);
    // Task 4 cutover clears this flag; Today itself does not rewrite historical data.
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'flagged-later')).get()
        ?.needsReinforcement,
    ).toBe(1);
  });

  it('pre-existing Read task remains in history but is not copied to a new session', async () => {
    await seedFlaggedItem('legacy', false);
    db.insert(reviewSessions)
      .values({
        id: 'old-session',
        sessionDate: '2026-09-23',
        startedAt: '2026-09-23T02:00:00.000Z',
        completedAt: '2026-09-23T02:00:00.000Z',
        baseTaskCount: 1,
        newItemsStarted: 0,
        createdAt: '2026-09-23T02:00:00.000Z',
      })
      .run();
    db.insert(reviewTasks)
      .values({
        id: 'old-read-task',
        sessionId: 'old-session',
        learningItemId: 'legacy',
        dimension: 'understanding',
        questionId: null,
        taskType: 'understanding',
        origin: 'read_reinforcement',
        sortKey: 1,
        deferCount: 0,
        completedAt: null,
        canceledAt: null,
        createdAt: '2026-09-23T02:00:00.000Z',
      })
      .run();
    await startTodaySession(db, createFakeDeps(), TZ, NOW);
    const current = await getSessionTasks(db, TZ, NOW);
    expect(current.tasks).toHaveLength(0);
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.id, 'old-read-task')).get()?.origin,
    ).toBe('read_reinforcement');
  });
});
