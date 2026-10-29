import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnswerResponse, LibraryItemDetail, PracticeAnswerResponse } from '@el/shared';
import { eq } from 'drizzle-orm';
import {
  attemptItemResults,
  attempts,
  dailyStats,
  questions,
  reviewStates,
  reviewTasks,
} from '../../src/db/schema.js';
import { advanceReviewState } from '../../src/modules/review/service.js';
import {
  prepareTodayTask,
  setTodayDepsForTests,
  startTodaySession,
} from '../../src/modules/today/service.js';
import { setPracticeDepsForTests } from '../../src/modules/practice/service.js';
import { createFakeDeps, fakeScramblePayload } from '../helpers/today-fakes.js';
import { seedExample, seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';
import { createTestApp, loginCookie, type TestApp } from '../helpers/test-app.js';

let ctx: TestApp;
let cookie: string;
const deps = { ...createFakeDeps(), advance: advanceReviewState };
beforeEach(async () => {
  ctx = createTestApp();
  cookie = await loginCookie(ctx.app);
  setTodayDepsForTests(deps);
  setPracticeDepsForTests(deps);
});
afterEach(async () => {
  await ctx.app.close();
  setTodayDepsForTests(null);
  setPracticeDepsForTests(null);
});
async function seed(id: string) {
  await seedItem(ctx.db, { id, type: 'chunk', target: id, queueState: 'started' });
  await seedExample(ctx.db, id, 'source', `Please use ${id}.`);
  await seedReviewState(ctx.db, id, 'production', {
    difficulty: 5,
    stability: 25,
    reps: 4,
    nextReviewAt: '2026-01-01T00:00:00.000Z',
    lastReviewAt: '2026-01-01T00:00:00.000Z',
  });
}
const post = (url: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie }, payload });

describe('scramble HTTP evidence contract', () => {
  it('rejects fabricated chips without writes, then atomically records and replays separate item evidence', async () => {
    await seed('alpha');
    await seed('beta');
    const now = new Date();
    await startTodaySession(ctx.db, deps, 'Asia/Shanghai', now);
    const task = ctx.db.select().from(reviewTasks).all()[0]!;
    await prepareTodayTask(ctx.db, deps, 'Asia/Shanghai', now, task.id);
    const url = `/api/today/tasks/${task.id}/answer`;
    const invalid = await post(url, { selectedTokens: ['fabricated'] });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('VALIDATION_ERROR');
    expect(ctx.db.select().from(attempts).all()).toHaveLength(0);
    expect(ctx.db.select().from(dailyStats).all()).toHaveLength(0);
    const submitted = await post(url, { selectedTokens: ['Please', 'alpha', 'always', 'today'] });
    expect(submitted.statusCode).toBe(200);
    const first = AnswerResponse.parse(submitted.json());
    expect(first.itemResults?.map((r) => r.result)).toEqual(['basic_pass', 'fail']);
    expect(
      ctx.db
        .select()
        .from(attemptItemResults)
        .all()
        .map((r) => r.result),
    ).toEqual(['basic_pass', 'fail']);
    const replay = await post(url, { giveUp: true });
    expect(AnswerResponse.parse(replay.json()).itemResults).toEqual(first.itemResults);
    expect(ctx.db.select().from(attempts).all()).toHaveLength(1);
    expect(ctx.db.select().from(dailyStats).get()!.formalTasksCompleted).toBe(1);
    const histories = await Promise.all(
      ['alpha', 'beta'].map(async (id) => {
        const detail = await ctx.app.inject({
          method: 'GET',
          url: `/api/library/${id}`,
          headers: { cookie },
        });
        expect(detail.statusCode).toBe(200);
        return LibraryItemDetail.parse(detail.json()).productionHistory.map((h) => h.result);
      }),
    );
    expect(histories).toEqual([['basic_pass'], ['fail']]);
  });

  it('Practice validates the same chip inventory and never changes formal state', async () => {
    await seed('alpha');
    const payload = fakeScramblePayload([{ id: 'alpha', target: 'alpha' }]);
    const questionId = await seedQuestion(ctx.db, 'alpha', {
      type: 'production',
      payloadJson: JSON.stringify(payload),
    });
    const before = ctx.db.select().from(reviewStates).all();
    const url = `/api/library/alpha/practice/${questionId}/answer`;
    expect(
      (await post(url, { selectedTokens: ['Please', 'alpha', 'alpha', 'today'] })).statusCode,
    ).toBe(400);
    expect(ctx.db.select().from(attempts).all()).toHaveLength(0);
    const valid = await post(url, { selectedTokens: ['Please', 'alpha', 'today'] });
    expect(valid.statusCode).toBe(200);
    expect(PracticeAnswerResponse.parse(valid.json()).result).toBe('pass');
    expect(ctx.db.select().from(reviewStates).all()).toEqual(before);
    expect(ctx.db.select().from(dailyStats).all()).toHaveLength(0);
  });

  it('rejects malformed stored payloads even for give-up without advancing an item', async () => {
    await seed('alpha');
    const now = new Date();
    await startTodaySession(ctx.db, deps, 'Asia/Shanghai', now);
    const task = ctx.db.select().from(reviewTasks).all()[0]!;
    await prepareTodayTask(ctx.db, deps, 'Asia/Shanghai', now, task.id);
    const bound = ctx.db.select().from(reviewTasks).where(eq(reviewTasks.id, task.id)).get()!;
    ctx.db
      .update(questions)
      .set({
        payloadJson: JSON.stringify({ schema: 'scramble_v1', referenceTokens: [], targets: [] }),
      })
      .where(eq(questions.id, bound.questionId!))
      .run();
    const response = await post(`/api/today/tasks/${task.id}/answer`, { giveUp: true });
    expect(response.statusCode).toBe(409);
    expect(ctx.db.select().from(attempts).all()).toHaveLength(0);
    expect(ctx.db.select().from(reviewStates).get()!.reps).toBe(4);
  });
});

describe('Library production history compatibility', () => {
  it('keeps legacy fallback, participant scope and void precedence over stale item results', async () => {
    for (const id of ['alpha', 'beta', 'unrelated']) await seed(id);
    const questionId = await seedQuestion(ctx.db, 'alpha', { type: 'production' });
    for (const [id, result, child, voidedAt] of [
      ['legacy', 'basic_pass', null, null],
      ['parent-void', 'void', 'pass', null],
      ['timestamp-void', 'pass', 'pass', '2026-10-29T02:00:00.000Z'],
      ['child-void', 'pass', 'void', null],
    ] as const) {
      ctx.db
        .insert(attempts)
        .values({
          id,
          learningItemId: 'alpha',
          questionId,
          mode: 'today',
          result,
          answerText: 'Retained sentence.',
          createdAt: '2026-10-29T01:00:00.000Z',
          voidedAt,
        })
        .run();
      if (child)
        for (const learningItemId of ['alpha', 'beta']) {
          ctx.db
            .insert(attemptItemResults)
            .values({
              id: `${id}-${learningItemId}`,
              attemptId: id,
              learningItemId,
              result: child,
              createdAt: '2026-10-29T01:00:00.000Z',
            })
            .run();
        }
    }
    const stored = ctx.db.select().from(attempts).all();
    const audit = ctx.db.select().from(attemptItemResults).all();
    const histories = await Promise.all(
      ['alpha', 'beta', 'unrelated'].map(async (id) => {
        const response = await ctx.app.inject({
          method: 'GET',
          url: `/api/library/${id}`,
          headers: { cookie },
        });
        expect(response.statusCode).toBe(200);
        return Object.fromEntries(
          LibraryItemDetail.parse(response.json()).productionHistory.map((h) => [h.id, h.result]),
        );
      }),
    );
    expect(histories).toEqual([
      {
        legacy: 'basic_pass',
        'parent-void': 'void',
        'timestamp-void': 'void',
        'child-void': 'void',
      },
      { 'parent-void': 'void', 'timestamp-void': 'void', 'child-void': 'void' },
      {},
    ]);
    expect(ctx.db.select().from(attempts).all()).toEqual(stored);
    expect(ctx.db.select().from(attemptItemResults).all()).toEqual(audit);
  });
});
