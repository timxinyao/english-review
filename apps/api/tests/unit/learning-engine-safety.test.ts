import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  attempts,
  attemptItemResults,
  learningItems,
  questions,
  reviewStates,
  reviewTaskItems,
  reviewTasks,
  settings,
} from '../../src/db/schema.js';
import { acquireQuestion, invalidateQuestions } from '../../src/modules/questions/service.js';
import {
  answerTodayTask,
  cancelPendingProductionTasksForItem,
  getTodayStatus,
  prepareTodayTask,
  reportBadQuestion,
  startTodaySession,
  submitTaskFeedback,
  undoTodayTask,
} from '../../src/modules/today/service.js';
import {
  getLearningItemDetail,
  pauseLearningItem,
  archiveLearningItem,
  resetLearningItem,
} from '../../src/modules/learning-items/service.js';
import { advanceReviewState } from '../../src/modules/review/service.js';
import { seedExample, seedItem, seedReviewState } from '../helpers/seed.js';
import { createFakeDeps, fakeScramblePayload } from '../helpers/today-fakes.js';

const NOW = new Date('2026-10-29T02:00:00.000Z');
const TZ = 'Asia/Shanghai';
let db: AppDatabase;
const deps = () => ({ ...createFakeDeps(), advance: advanceReviewState });
beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

async function due(
  id: string,
  dimension: 'understanding' | 'production',
  at = '2026-10-28T00:00:00.000Z',
) {
  if (!db.select().from(learningItems).where(eq(learningItems.id, id)).get()) {
    await seedItem(db, { id, type: 'chunk', target: id, queueState: 'started' });
  }
  await seedReviewState(db, id, dimension, {
    difficulty: 5,
    stability: 25,
    reps: 4,
    nextReviewAt: at,
    lastReviewAt: '2026-10-20T00:00:00.000Z',
  });
}
async function group() {
  await due('alpha', 'production');
  await due('beta', 'production');
  await startTodaySession(db, deps(), TZ, NOW);
  const task = db
    .select()
    .from(reviewTasks)
    .all()
    .find((t) => t.taskType === 'production')!;
  await prepareTodayTask(db, deps(), TZ, NOW, task.id);
  return db.select().from(reviewTasks).where(eq(reviewTasks.id, task.id)).get()!;
}
function state(id: string, dimension: 'understanding' | 'production') {
  return db
    .select()
    .from(reviewStates)
    .where(and(eq(reviewStates.learningItemId, id), eq(reviewStates.dimension, dimension)))
    .get();
}
function ref(task: typeof reviewTasks.$inferSelect): string[] {
  return JSON.parse(
    db.select().from(questions).where(eq(questions.id, task.questionId!)).get()!.payloadJson,
  ).referenceTokens;
}

describe('grouped review planning', () => {
  it('ranks overdue Production ahead of newer Understanding before applying the cap', async () => {
    db.insert(settings).values({ id: 1, todayReviewLimit: 10, updatedAt: NOW.toISOString() }).run();
    await due('old-p', 'production', '2026-10-01T00:00:00.000Z');
    for (let i = 0; i < 10; i++) await due(`new-u-${i}`, 'understanding');
    await startTodaySession(db, deps(), TZ, NOW);
    const tasks = db.select().from(reviewTasks).all();
    expect(tasks).toHaveLength(10);
    expect(tasks.some((t) => t.learningItemId === 'old-p')).toBe(true);
  });
  it('idle counts grouped tasks consistently with the actual session', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await due(id, 'production');
    expect(getTodayStatus(db, TZ, NOW)).toMatchObject({
      status: 'idle',
      plannedReviews: 2,
      backlogLeft: 0,
    });
    await startTodaySession(db, deps(), TZ, NOW);
    expect(db.select().from(reviewTasks).all()).toHaveLength(2);
  });
});

describe('participant boundaries', () => {
  it('invalidates a grouped question when a secondary participant changes', async () => {
    const task = await group();
    expect(invalidateQuestions(db, 'beta', NOW.toISOString())).toBe(1);
    expect(
      db.select().from(questions).where(eq(questions.id, task.questionId!)).get()!.status,
    ).toBe('retired');
  });
  it('cancels a pending grouped task when a secondary participant disables Production', async () => {
    const task = await group();
    db.transaction((tx) =>
      cancelPendingProductionTasksForItem(tx, 'beta', '2026-10-29', NOW.toISOString()),
    );
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.id, task.id)).get()!.canceledAt,
    ).not.toBeNull();
    expect(state('alpha', 'production')!.reps).toBe(4);
  });
  it('never takes a grouped question from single-item practice stock', async () => {
    const task = await group();
    expect(acquireQuestion(db, 'alpha', 'production', NOW)).toBeNull();
    expect(task.questionId).not.toBeNull();
  });
  it('rejects fabricated or over-consumed chips with zero learning writes', async () => {
    const task = await group();
    for (const selectedTokens of [['fabricated'], [...ref(task), 'alpha']]) {
      await expect(
        answerTodayTask(db, deps(), TZ, NOW, task.id, { selectedTokens }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(db.select().from(attempts).all()).toHaveLength(0);
    expect(state('alpha', 'production')!.reps).toBe(4);
  });
  it('rejects participant mismatches before any grading or state writes', async () => {
    const task = await group();
    const payload = fakeScramblePayload([{ id: 'alpha', target: 'alpha' }]);
    db.update(questions)
      .set({ payloadJson: JSON.stringify(payload) })
      .where(eq(questions.id, task.questionId!))
      .run();
    await expect(
      answerTodayTask(db, deps(), TZ, NOW, task.id, { selectedTokens: payload.referenceTokens }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.select().from(attempts).all()).toHaveLength(0);
  });
});

describe('rollback preserves independent progress', () => {
  it('bad-question restores P without erasing later U progress of either participant', async () => {
    await due('alpha', 'understanding');
    await due('beta', 'understanding');
    const task = await group();
    await answerTodayTask(db, deps(), TZ, NOW, task.id, { selectedTokens: ref(task) });
    for (const id of ['alpha', 'beta']) {
      const u = db
        .select()
        .from(reviewTasks)
        .all()
        .find((t) => t.learningItemId === id && t.dimension === 'understanding')!;
      await answerTodayTask(db, deps(), TZ, new Date(NOW.getTime() + 1000), u.id, {
        recall: 'recalled',
      });
    }
    const before = ['alpha', 'beta'].map((id) => state(id, 'understanding'));
    reportBadQuestion(db, task.id, new Date(NOW.getTime() + 2000), TZ);
    expect(['alpha', 'beta'].map((id) => state(id, 'understanding'))).toEqual(before);
    expect(state('alpha', 'production')!.reps).toBe(4);
    expect(state('beta', 'production')!.reps).toBe(4);
  });
  it('refuses to overwrite a secondary participant P state changed after the attempt', async () => {
    const task = await group();
    await answerTodayTask(db, deps(), TZ, NOW, task.id, { selectedTokens: ref(task) });
    db.transaction((tx) =>
      advanceReviewState(
        tx,
        'beta',
        'production',
        { kind: 'pass' },
        new Date(NOW.getTime() + 1000),
      ),
    );
    const before = state('beta', 'production');
    expect(() => reportBadQuestion(db, task.id, new Date(NOW.getTime() + 2000), TZ)).toThrow();
    expect(state('beta', 'production')).toEqual(before);
    expect(db.select().from(attempts).all()[0]!.result).toBe('pass');
  });
  it('undo voids both task-participant and attempt-participant audit results', async () => {
    const task = await group();
    await answerTodayTask(db, deps(), TZ, NOW, task.id, { selectedTokens: ref(task) });
    await undoTodayTask(db, deps(), TZ, new Date(NOW.getTime() + 1000), task.id);
    expect(
      db
        .select()
        .from(reviewTaskItems)
        .where(eq(reviewTaskItems.reviewTaskId, task.id))
        .all()
        .map((r) => r.result),
    ).toEqual(['void', 'void']);
    expect(
      db
        .select()
        .from(attemptItemResults)
        .all()
        .map((r) => r.result),
    ).toEqual(['void', 'void']);
  });
});

describe('settlement and rollback edge cases', () => {
  it.each(['alpha', 'beta'])(
    'keeps scheduled Production answerable when %s becomes mastered through Understanding',
    async (masteringId) => {
      await due('alpha', 'production');
      await due('beta', 'production');
      await due(masteringId, 'understanding', '2026-10-27T00:00:00.000Z');
      db.update(reviewStates)
        .set({ stability: 130, lastReviewAt: '2026-06-20T00:00:00.000Z' })
        .where(
          and(
            eq(reviewStates.learningItemId, masteringId),
            eq(reviewStates.dimension, 'production'),
          ),
        )
        .run();
      db.update(reviewStates)
        .set({ stability: 110, lastReviewAt: '2026-06-20T00:00:00.000Z' })
        .where(
          and(
            eq(reviewStates.learningItemId, masteringId),
            eq(reviewStates.dimension, 'understanding'),
          ),
        )
        .run();
      await startTodaySession(db, deps(), TZ, NOW);
      const tasks = db.select().from(reviewTasks).all();
      const production = tasks.find((t) => t.taskType === 'production')!;
      const understanding = tasks.find((t) => t.taskType === 'understanding')!;
      await prepareTodayTask(db, deps(), TZ, NOW, production.id);
      await answerTodayTask(db, deps(), TZ, NOW, understanding.id, { recall: 'recalled' });
      expect(
        db.select().from(learningItems).where(eq(learningItems.id, masteringId)).get()!.status,
      ).toBe('mastered');
      // Refresh/prepare and settlement must both retain this already-scheduled task.
      await prepareTodayTask(db, deps(), TZ, NOW, production.id);
      const prepared = db
        .select()
        .from(reviewTasks)
        .where(eq(reviewTasks.id, production.id))
        .get()!;
      const answer = await answerTodayTask(db, deps(), TZ, NOW, production.id, {
        selectedTokens: ref(prepared),
      });
      expect(answer.result).toBe('pass');
      expect(answer.progress).toEqual({ completed: 2, total: 2 });
      expect(
        db
          .select()
          .from(attemptItemResults)
          .all()
          .map((r) => r.result),
      ).toEqual(['pass', 'pass']);
    },
  );
  it.each(['paused', 'archived'])(
    'does not settle a task after a secondary participant becomes %s',
    async (status) => {
      const task = await group();
      db.update(learningItems).set({ status }).where(eq(learningItems.id, 'beta')).run();
      await expect(
        answerTodayTask(db, deps(), TZ, NOW, task.id, { selectedTokens: ref(task) }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(db.select().from(attempts).all()).toHaveLength(0);
    },
  );
  it('does not settle a task after a secondary participant disables Production', async () => {
    const task = await group();
    db.update(learningItems)
      .set({ productionEnabledOverride: 0 })
      .where(eq(learningItems.id, 'beta'))
      .run();
    await expect(
      answerTodayTask(db, deps(), TZ, NOW, task.id, { giveUp: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.select().from(attempts).all()).toHaveLength(0);
  });
  it('partial evidence uses Hard for the supported target and survives idempotent replay', async () => {
    const task = await group();
    const answer = await answerTodayTask(db, deps(), TZ, NOW, task.id, {
      selectedTokens: ['Please', 'alpha', 'always', 'today'],
    });
    expect(answer.result).toBe('fail');
    expect(answer.itemResults).toEqual([
      { learningItemId: 'alpha', surface: 'alpha', result: 'basic_pass' },
      { learningItemId: 'beta', surface: 'beta', result: 'fail' },
    ]);
    expect(state('alpha', 'production')!.lapses).toBe(0);
    expect(state('alpha', 'production')!.difficulty).toBeGreaterThan(5);
    expect(state('beta', 'production')!.lapses).toBe(1);
    const replay = await answerTodayTask(db, deps(), TZ, NOW, task.id, { giveUp: true });
    expect(replay.itemResults).toEqual(answer.itemResults);
    expect(db.select().from(attempts).all()).toHaveLength(1);
  });
  it('bad-question never restores active over an explicit pause or archive', async () => {
    const task = await group();
    await answerTodayTask(db, deps(), TZ, NOW, task.id, { selectedTokens: ref(task) });
    db.update(learningItems).set({ status: 'paused' }).where(eq(learningItems.id, 'alpha')).run();
    db.update(learningItems)
      .set({ status: 'archived', archivedAt: NOW.toISOString() })
      .where(eq(learningItems.id, 'beta'))
      .run();
    reportBadQuestion(db, task.id, new Date(NOW.getTime() + 2000), TZ);
    expect(db.select().from(learningItems).where(eq(learningItems.id, 'alpha')).get()!.status).toBe(
      'paused',
    );
    expect(db.select().from(learningItems).where(eq(learningItems.id, 'beta')).get()!.status).toBe(
      'archived',
    );
  });
});

describe('retained multi-item audit history', () => {
  it('undo restores per-item audit rows cascaded away by the ten-attempt history limit', async () => {
    const task = await group();
    for (let i = 0; i < 10; i++) {
      ctxSeed(i);
    }
    function ctxSeed(index: number) {
      db.insert(attempts)
        .values({
          id: `history-${index}`,
          learningItemId: 'alpha',
          questionId: task.questionId,
          mode: 'library_practice',
          result: 'pass',
          createdAt: `2026-10-20T00:${String(index).padStart(2, '0')}:00.000Z`,
        })
        .run();
      db.insert(attemptItemResults)
        .values({
          id: `history-result-${index}`,
          attemptId: `history-${index}`,
          learningItemId: 'beta',
          result: 'basic_pass',
          detailJson: '{"source":"retained"}',
          createdAt: '2026-10-20T00:00:00.000Z',
        })
        .run();
    }
    const old = db
      .select()
      .from(attemptItemResults)
      .where(eq(attemptItemResults.id, 'history-result-0'))
      .get();
    await answerTodayTask(db, deps(), TZ, NOW, task.id, { selectedTokens: ref(task) });
    expect(db.select().from(attempts).where(eq(attempts.id, 'history-0')).get()).toBeUndefined();
    await undoTodayTask(db, deps(), TZ, new Date(NOW.getTime() + 1000), task.id);
    expect(db.select().from(attempts).where(eq(attempts.id, 'history-0')).get()).toBeDefined();
    expect(
      db
        .select()
        .from(attemptItemResults)
        .where(eq(attemptItemResults.id, 'history-result-0'))
        .get(),
    ).toEqual(old);
  });
});

describe('lifecycle changes reconcile pending work', () => {
  it.each([
    ['pause', pauseLearningItem],
    ['archive', archiveLearningItem],
    ['reset', resetLearningItem],
  ] as const)(
    '%s cancels pending U and secondary-participant P without touching completed history',
    async (_action, transition) => {
      await due('alpha', 'production');
      await due('beta', 'production');
      await due('beta', 'understanding');
      await due('completed', 'understanding');
      await due('remaining', 'understanding');
      await startTodaySession(db, deps(), TZ, NOW);
      const tasks = db.select().from(reviewTasks).all();
      const completed = tasks.find((t) => t.learningItemId === 'completed')!;
      await answerTodayTask(db, deps(), TZ, NOW, completed.id, { recall: 'recalled' });
      const beforeHistory = db.select().from(attempts).all();
      const alphaBefore = state('alpha', 'production');
      await seedExample(db, 'beta', 'source', 'Please use beta.');
      await transition(db, 'beta');
      const changed = db.select().from(reviewTasks).all();
      expect(
        changed
          .filter((t) => t.taskType === 'production' || t.learningItemId === 'beta')
          .every((t) => t.canceledAt !== null),
      ).toBe(true);
      expect(changed.find((t) => t.id === completed.id)!.canceledAt).toBeNull();
      expect(db.select().from(attempts).all()).toEqual(beforeHistory);
      expect(state('alpha', 'production')).toEqual(alphaBefore);
      expect(getTodayStatus(db, TZ, NOW)).toMatchObject({
        status: 'active',
        progress: { completed: 1, total: 2 },
        currentTask: { item: { id: 'remaining' } },
      });
      const remaining = changed.find((t) => t.learningItemId === 'remaining')!;
      await answerTodayTask(db, deps(), TZ, NOW, remaining.id, { recall: 'recalled' });
      expect(getTodayStatus(db, TZ, NOW).status).toBe('completed');
    },
  );

  it('reset cancels an unstarted Learn task rather than letting a stale tab start it', async () => {
    await seedItem(db, { id: 'new', queueState: 'new' });
    await startTodaySession(db, deps(), TZ, NOW);
    const task = db.select().from(reviewTasks).get()!;
    expect(task.taskType).toBe('learn');
    await seedExample(db, 'new', 'source', 'A new example.');
    await resetLearningItem(db, 'new');
    const before = db.select().from(reviewStates).all();
    await expect(
      answerTodayTask(db, deps(), TZ, NOW, task.id, { recall: 'recalled' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.select().from(attempts).all()).toHaveLength(0);
    expect(db.select().from(reviewStates).all()).toEqual(before);
    expect(getTodayStatus(db, TZ, NOW).status).toBe('completed');
  });

  it.each([
    ['understanding', 'paused', 'started'],
    ['understanding', 'archived', 'started'],
    ['understanding', 'active', 'new'],
    ['learn', 'paused', 'new'],
    ['learn', 'archived', 'new'],
    ['learn', 'active', 'started'],
  ] as const)(
    'rejects a retained %s task after status=%s queue=%s with zero writes',
    async (type, status, queueState) => {
      if (type === 'learn') await seedItem(db, { id: 'stale', queueState: 'new' });
      else await due('stale', 'understanding');
      await startTodaySession(db, deps(), TZ, NOW);
      const task = db.select().from(reviewTasks).get()!;
      db.update(learningItems)
        .set({ status, queueState })
        .where(eq(learningItems.id, 'stale'))
        .run();
      const before = db.select().from(reviewStates).all();
      await expect(
        answerTodayTask(db, deps(), TZ, NOW, task.id, { recall: 'recalled' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(db.select().from(attempts).all()).toHaveLength(0);
      expect(db.select().from(reviewStates).all()).toEqual(before);
    },
  );
});

describe('undo replacement eligibility', () => {
  it.each(['paused', 'archived', 'production-disabled'])(
    'rejects undo without writes when a secondary participant is %s',
    async (change) => {
      const task = await group();
      await answerTodayTask(db, deps(), TZ, NOW, task.id, { selectedTokens: ref(task) });
      db.update(learningItems)
        .set(
          change === 'production-disabled' ? { productionEnabledOverride: 0 } : { status: change },
        )
        .where(eq(learningItems.id, 'beta'))
        .run();
      const before = db.select().from(reviewStates).all();
      const history = db.select().from(attempts).all();
      await expect(undoTodayTask(db, deps(), TZ, NOW, task.id)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(db.select().from(reviewStates).all()).toEqual(before);
      expect(db.select().from(attempts).all()).toEqual(history);
      expect(db.select().from(reviewTasks).all()).toHaveLength(1);
    },
  );
  it.each(['understanding', 'learn'] as const)(
    'does not create a replacement %s for a paused item',
    async (type) => {
      if (type === 'learn') await seedItem(db, { id: 'paused', queueState: 'new' });
      else await due('paused', 'understanding');
      await startTodaySession(db, deps(), TZ, NOW);
      const task = db.select().from(reviewTasks).get()!;
      await answerTodayTask(db, deps(), TZ, NOW, task.id, { recall: 'recalled' });
      db.update(learningItems)
        .set({ status: 'paused' })
        .where(eq(learningItems.id, 'paused'))
        .run();
      const history = db.select().from(attempts).all();
      await expect(undoTodayTask(db, deps(), TZ, NOW, task.id)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(db.select().from(attempts).all()).toEqual(history);
      expect(db.select().from(reviewTasks).all()).toHaveLength(1);
    },
  );
  it('rechecks participant goals after awaiting replacement generation before rollback', async () => {
    const task = await group();
    await answerTodayTask(db, deps(), TZ, NOW, task.id, { selectedTokens: ref(task) });
    const before = db.select().from(reviewStates).all();
    const history = db.select().from(attempts).all();
    const undoDeps = deps();
    const generate = undoDeps.generateScramble!;
    undoDeps.generateScramble = async (...args) => {
      const replacement = await generate(...args);
      db.update(learningItems)
        .set({ productionEnabledOverride: 0 })
        .where(eq(learningItems.id, 'beta'))
        .run();
      return replacement;
    };
    await expect(undoTodayTask(db, undoDeps, TZ, NOW, task.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(db.select().from(reviewStates).all()).toEqual(before);
    expect(db.select().from(attempts).all()).toEqual(history);
    expect(db.select().from(reviewTasks).all()).toHaveLength(1);
  });
});

describe('feedback cannot overwrite newer progress', () => {
  it('refuses guessed feedback when its retained pre-state snapshot is missing', async () => {
    await due('feedback', 'understanding');
    await startTodaySession(db, deps(), TZ, NOW);
    const task = db.select().from(reviewTasks).get()!;
    await answerTodayTask(db, deps(), TZ, NOW, task.id, { recall: 'recalled' });
    db.update(attempts).set({ preStateJson: null }).where(eq(attempts.reviewTaskId, task.id)).run();
    const before = db.select().from(reviewStates).all();
    const history = db.select().from(attempts).all();
    expect(() => submitTaskFeedback(db, deps(), TZ, task.id, 'guessed', NOW)).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    expect(db.select().from(reviewStates).all()).toEqual(before);
    expect(db.select().from(attempts).all()).toEqual(history);
  });
  it.each([
    ['guessed', 'later-understanding'],
    ['too_easy', 'later-understanding'],
    ['guessed', 'reset'],
    ['too_easy', 'reset'],
    ['guessed', 'paused'],
    ['too_easy', 'paused'],
    ['guessed', 'archived'],
    ['too_easy', 'archived'],
  ] as const)('rejects %s after %s with zero learning/history writes', async (feedback, change) => {
    await due('feedback', 'understanding');
    await startTodaySession(db, deps(), TZ, NOW);
    const task = db.select().from(reviewTasks).get()!;
    await answerTodayTask(db, deps(), TZ, NOW, task.id, { recall: 'recalled' });
    if (change === 'later-understanding') {
      db.transaction((tx) =>
        advanceReviewState(
          tx,
          'feedback',
          'understanding',
          { kind: 'pass' },
          new Date(NOW.getTime() + 1000),
        ),
      );
    } else if (change === 'reset') {
      await seedExample(db, 'feedback', 'source', 'Please give feedback.');
      await resetLearningItem(db, 'feedback');
    } else {
      db.update(learningItems)
        .set({ status: change })
        .where(eq(learningItems.id, 'feedback'))
        .run();
    }
    const before = db.select().from(reviewStates).all();
    const history = db.select().from(attempts).all();
    const item = db.select().from(learningItems).get();
    expect(() =>
      submitTaskFeedback(db, deps(), TZ, task.id, feedback, new Date(NOW.getTime() + 2000)),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(db.select().from(reviewStates).all()).toEqual(before);
    expect(db.select().from(attempts).all()).toEqual(history);
    expect(db.select().from(learningItems).get()).toEqual(item);
  });

  it.each(['guessed', 'too_easy'] as const)(
    '%s preserves later independent Production progress',
    async (feedback) => {
      await due('feedback', 'understanding');
      await due('feedback', 'production');
      await startTodaySession(db, deps(), TZ, NOW);
      const task = db
        .select()
        .from(reviewTasks)
        .all()
        .find((t) => t.taskType === 'understanding')!;
      await answerTodayTask(db, deps(), TZ, NOW, task.id, { recall: 'recalled' });
      db.transaction((tx) =>
        advanceReviewState(
          tx,
          'feedback',
          'production',
          { kind: 'pass' },
          new Date(NOW.getTime() + 1000),
        ),
      );
      const production = state('feedback', 'production');
      expect(
        submitTaskFeedback(db, deps(), TZ, task.id, feedback, new Date(NOW.getTime() + 2000)).ok,
      ).toBe(true);
      expect(state('feedback', 'production')).toEqual(production);
    },
  );
});

describe('per-item production history projection', () => {
  it('shows primary partial credit and secondary failure without changing stored task evidence', async () => {
    const task = await group();
    for (const id of ['alpha', 'beta']) await seedExample(db, id, 'source', `Please use ${id}.`);
    await answerTodayTask(db, deps(), TZ, NOW, task.id, {
      selectedTokens: ['Please', 'alpha', 'always', 'today'],
    });
    const stored = db.select().from(attempts).all();
    const audit = db.select().from(attemptItemResults).all();
    const states = db.select().from(reviewStates).all();
    expect(stored[0]!.result).toBe('fail');
    const histories = await Promise.all(
      ['alpha', 'beta'].map(async (id) =>
        (await getLearningItemDetail(db, id)).productionHistory.map((h) => ({
          id: h.id,
          result: h.result,
        })),
      ),
    );
    expect(histories).toEqual([
      [{ id: stored[0]!.id, result: 'basic_pass' }],
      [{ id: stored[0]!.id, result: 'fail' }],
    ]);
    expect(db.select().from(attempts).all()).toEqual(stored);
    expect(db.select().from(attemptItemResults).all()).toEqual(audit);
    expect(db.select().from(reviewStates).all()).toEqual(states);
  });
});
