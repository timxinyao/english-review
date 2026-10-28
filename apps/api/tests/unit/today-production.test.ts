import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TodayTaskView } from '@el/shared';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  attemptItemResults,
  attempts,
  dailyStats,
  learningExamples,
  questionItems,
  questions,
  reviewStates,
  reviewTaskItems,
  reviewTasks,
} from '../../src/db/schema.js';
import {
  answerTodayTask,
  getTodayStatus,
  prepareTodayTask,
  reportBadQuestion,
  startTodaySession as startTodaySessionRaw,
  submitTaskFeedback,
  type TodayDeps,
} from '../../src/modules/today/service.js';
import { requestDisconnected } from '../../src/modules/today/routes.js';
import { seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';
import {
  createFakeDeps,
  fakeScramblePayload,
  type FakeDepsOptions,
} from '../helpers/today-fakes.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-09-24T02:00:00.000Z');
const DAY_MS = 24 * 3600 * 1000;
const DUE = '2026-09-23T00:00:00.000Z';

let db: AppDatabase;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

async function startTodaySession(
  testDb: AppDatabase,
  testDeps: TodayDeps,
  timezone: string,
  now: Date,
) {
  const result = await startTodaySessionRaw(testDb, testDeps, timezone, now);
  if (result.status === 'active') {
    for (const task of testDb.select().from(reviewTasks).all()) {
      if (
        task.sessionId === result.session.id &&
        task.completedAt === null &&
        task.canceledAt === null
      ) {
        await prepareTodayTask(testDb, testDeps, timezone, now, task.id);
      }
    }
  }
  return result;
}

/** Seed due Production item + scramble_v1 stock question (single-item). */
async function seedProductionItem(
  itemId: string,
  stability: number,
  opts: { target?: string } = {},
): Promise<string> {
  const target = opts.target ?? itemId;
  await seedItem(db, { id: itemId, type: 'chunk', target, queueState: 'started' });
  await seedReviewState(db, itemId, 'production', {
    difficulty: 5,
    stability,
    reps: 4,
    lapses: 0,
    nextReviewAt: DUE,
    lastReviewAt: '2026-09-20T00:00:00.000Z',
  });
  const payload = fakeScramblePayload([{ id: itemId, target }]);
  await seedQuestion(db, itemId, {
    id: `${itemId}-prod`,
    type: 'production',
    promptText: payload.zhPrompt,
    payloadJson: JSON.stringify(payload),
    correctOptionId: null,
  });
  db.insert(questionItems)
    .values({
      id: `qi-${itemId}-prod`,
      questionId: `${itemId}-prod`,
      learningItemId: itemId,
      sortIndex: 0,
      createdAt: NOW.toISOString(),
    })
    .run();
  return itemId;
}

async function startAndGet(): Promise<TodayTaskView> {
  const res = await startTodaySession(db, deps(), TZ, NOW);
  if (res.status !== 'active') throw new Error(`start 失败：${res.status}`);
  const status = getTodayStatus(db, TZ, NOW);
  if (status.status !== 'active' || !status.currentTask) throw new Error('无当前任务');
  return status.currentTask;
}

function deps(overrides: FakeDepsOptions = {}): TodayDeps {
  return createFakeDeps(overrides);
}

function refTokensFor(itemId: string, target = itemId): string[] {
  return fakeScramblePayload([{ id: itemId, target }]).referenceTokens;
}

describe('P 维度题型映射（TodayTaskView scramble）', () => {
  it('到期 Production → scramble 任务视图（chips/targets，不泄露 referenceTokens）', async () => {
    await seedProductionItem('item-l4', 25);
    const task = await startAndGet();
    expect(task.taskType).toBe('production');
    expect(task.dimension).toBe('production');
    expect(task.question).toMatchObject({
      kind: 'scramble',
      questionId: 'item-l4-prod',
    });
    const q = task.question as Extract<TodayTaskView['question'], { kind: 'scramble' }>;
    expect(q.zhPrompt).toContain('item-l4');
    expect(q.targets.some((t) => t.learningItemId === 'item-l4')).toBe(true);
    expect(q.chips.length).toBeGreaterThan(0);
    expect(JSON.stringify(task.question)).not.toContain('referenceTokens');
    // chips may include sentence words; order of reference must not be exposed as a field
    expect('referenceTokens' in (task.question as object)).toBe(false);
  });

  it('多项到期 Production 组队：一题绑 2～3 项，占用 1 个计划名额', async () => {
    await seedProductionItem('g-a', 25, { target: 'wear down' });
    await seedProductionItem('g-b', 25, { target: 'meetings' });
    await seedProductionItem('g-c', 25, { target: 'deadlines' });
    await startTodaySession(db, deps(), TZ, NOW);
    const tasks = db.select().from(reviewTasks).all().filter((t) => t.taskType === 'production');
    expect(tasks).toHaveLength(1);
    const links = db
      .select()
      .from(reviewTaskItems)
      .where(eq(reviewTaskItems.reviewTaskId, tasks[0]!.id))
      .all();
    expect(links).toHaveLength(3);
    expect(new Set(links.map((l) => l.learningItemId))).toEqual(new Set(['g-a', 'g-b', 'g-c']));
  });
});

describe('today scramble production answer', () => {
  async function answerTokens(
    itemId: string,
    selectedTokens: string[],
    depsOverride?: TodayDeps,
  ): Promise<Awaited<ReturnType<typeof answerTodayTask>>> {
    const d = depsOverride ?? deps();
    const started = await startTodaySession(db, d, TZ, NOW);
    if (started.status !== 'active') throw new Error('start 失败');
    const task = db
      .select()
      .from(reviewTasks)
      .where(eq(reviewTasks.learningItemId, itemId))
      .all()[0]!;
    return answerTodayTask(db, d, TZ, NOW, task.id, { selectedTokens });
  }

  it('pass：按序拼对 → Production 推进、attempt_item_results、统计、无 personal example', async () => {
    await seedProductionItem('item-p', 25);
    const tokens = refTokensFor('item-p');
    const res = await answerTokens('item-p', tokens);

    expect(res.result).toBe('pass');
    expect(res.correct).toBe(true);
    expect(res.itemResults).toEqual([
      { learningItemId: 'item-p', surface: 'item-p', result: 'pass' },
    ]);
    expect(res.personalExampleSaved).toBe(false);
    expect(res.correction).toBeNull();
    expect(res.referenceTokens).toBeNull();
    expect(res.answerNote).toBeNull();

    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'item-p'))
      .all()
      .find((r) => r.dimension === 'production')!;
    expect(p.reps).toBe(5);
    expect(Date.parse(p.nextReviewAt!)).toBeGreaterThan(NOW.getTime() + DAY_MS);

    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.mode).toBe('today');
    expect(attempt.result).toBe('pass');
    expect(attempt.answerText).toBe(tokens.join(' '));
    expect(attempt.correctionJson).toBeNull();

    const itemRows = db
      .select()
      .from(attemptItemResults)
      .where(eq(attemptItemResults.attemptId, attempt.id))
      .all();
    expect(itemRows).toHaveLength(1);
    expect(itemRows[0]).toMatchObject({ learningItemId: 'item-p', result: 'pass' });

    const stats = db.select().from(dailyStats).get()!;
    expect(stats.formalTasksCompleted).toBe(1);
    expect(stats.productionAttempts).toBe(1);
    expect(stats.productionPass).toBe(1);

    expect(
      db.select().from(learningExamples).all().filter((e) => e.kind === 'personal'),
    ).toHaveLength(0);
  });

  it('fail：缺目标词 → 降级、揭示 referenceTokens、无补强、无 PE', async () => {
    await seedProductionItem('item-f', 25);
    // Omit target surface entirely → item fail + task fail
    const res = await answerTokens('item-f', ['Please', 'today']);

    expect(res.result).toBe('fail');
    expect(res.correct).toBe(false);
    expect(res.reinforcementAdded).toBe(false);
    expect(res.itemResults?.[0]?.result).toBe('fail');
    expect(res.referenceTokens).toEqual(refTokensFor('item-f'));
    expect(res.answerNote).toBe('允许变化。');
    expect(res.personalExampleSaved).toBe(false);

    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'item-f'))
      .all()
      .find((r) => r.dimension === 'production')!;
    expect(p.lapses).toBe(1);
    expect(db.select().from(reviewTasks).all()).toHaveLength(1);
  });

  it('scramble 生成失败：抛 AI_PROVIDER_ERROR 且零写入', async () => {
    await seedItem(db, { id: 'item-x', type: 'chunk', target: 'item-x', queueState: 'started' });
    await seedReviewState(db, 'item-x', 'production', {
      difficulty: 5,
      stability: 25,
      reps: 4,
      lapses: 0,
      nextReviewAt: DUE,
      lastReviewAt: '2026-09-20T00:00:00.000Z',
    });
    const failing = deps({ scrambleGenerateFail: true });
    const started = await startTodaySessionRaw(db, failing, TZ, NOW);
    if (started.status !== 'active') throw new Error('expected active pending session');
    const task = db.select().from(reviewTasks).all()[0]!;
    await expect(prepareTodayTask(db, failing, TZ, NOW, task.id)).rejects.toMatchObject({
      code: 'AI_PROVIDER_ERROR',
    });
    expect(db.select().from(attempts).all()).toHaveLength(0);
    expect(task.questionId ?? db.select().from(reviewTasks).all()[0]!.questionId).toBeNull();
  });

  it('幂等回放：重复提交返回首次 itemResults，不重复写入', async () => {
    await seedProductionItem('item-r', 25);
    const d = deps();
    const started = await startTodaySession(db, d, TZ, NOW);
    if (started.status !== 'active') throw new Error('start 失败');
    const task = db.select().from(reviewTasks).all()[0]!;
    const tokens = refTokensFor('item-r');

    const first = await answerTodayTask(db, d, TZ, NOW, task.id, { selectedTokens: tokens });
    expect(first.result).toBe('pass');
    const second = await answerTodayTask(db, d, TZ, new Date(NOW.getTime() + 60_000), task.id, {
      selectedTokens: ['wrong'],
    });

    expect(second.alreadyCompleted).toBe(true);
    expect(second.result).toBe(first.result);
    expect(second.itemResults).toEqual(first.itemResults);
    expect(db.select().from(attempts).all()).toHaveLength(1);
  });

  it('表达题必须提交 selectedTokens，否则 VALIDATION_ERROR', async () => {
    await seedProductionItem('item-v', 25);
    const d = deps();
    await startTodaySession(db, d, TZ, NOW);
    const task = db.select().from(reviewTasks).all()[0]!;
    await expect(
      answerTodayTask(db, d, TZ, NOW, task.id, { selectedOptionId: 'o1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(answerTodayTask(db, d, TZ, NOW, task.id, { answerText: 'x' })).rejects.toMatchObject(
      { code: 'VALIDATION_ERROR' },
    );
  });

  it('多词组句：一项对一项错 → 拆开回写 FSRS 与 attempt_item_results', async () => {
    await seedProductionItem('m-a', 25, { target: 'alpha' });
    await seedProductionItem('m-b', 25, { target: 'beta' });
    for (const id of ['m-a-prod', 'm-b-prod']) {
      db.delete(questionItems).where(eq(questionItems.questionId, id)).run();
      db.delete(questions).where(eq(questions.id, id)).run();
    }

    const d = deps();
    const started = await startTodaySession(db, d, TZ, NOW);
    if (started.status !== 'active') throw new Error('start 失败');
    const task = db.select().from(reviewTasks).all()[0]!;
    expect(
      db.select().from(reviewTaskItems).where(eq(reviewTaskItems.reviewTaskId, task.id)).all(),
    ).toHaveLength(2);

    // Fake multi payload: Please alpha beta today — omit beta → m-a pass, m-b fail
    const res = await answerTodayTask(db, d, TZ, NOW, task.id, {
      selectedTokens: ['Please', 'alpha', 'today'],
    });
    expect(res.result).toBe('fail');
    expect(res.itemResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ learningItemId: 'm-a', result: 'pass' }),
        expect.objectContaining({ learningItemId: 'm-b', result: 'fail' }),
      ]),
    );

    const sa = db
      .select()
      .from(reviewStates)
      .all()
      .find((r) => r.learningItemId === 'm-a' && r.dimension === 'production')!;
    const sb = db
      .select()
      .from(reviewStates)
      .all()
      .find((r) => r.learningItemId === 'm-b' && r.dimension === 'production')!;
    expect(sa.reps).toBe(5);
    expect(sb.lapses).toBe(1);
    expect(db.select().from(dailyStats).get()!.formalTasksCompleted).toBe(1);
  });
});

describe('production 与 bad-question / feedback（scramble）', () => {
  async function answerProductionPass(itemId: string): Promise<string> {
    const d = deps();
    const started = await startTodaySession(db, d, TZ, NOW);
    if (started.status !== 'active') throw new Error('start 失败');
    const task = db
      .select()
      .from(reviewTasks)
      .where(eq(reviewTasks.learningItemId, itemId))
      .all()[0]!;
    await answerTodayTask(db, d, TZ, NOW, task.id, {
      selectedTokens: refTokensFor(itemId),
    });
    return task.id;
  }

  it('feedback：production 任务拒绝（VALIDATION_ERROR）', async () => {
    await seedProductionItem('item-fb', 25);
    const taskId = await answerProductionPass('item-fb');
    await expect(async () =>
      submitTaskFeedback(db, deps(), TZ, taskId, 'guessed', new Date(NOW.getTime() + 60_000)),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('bad-question：回滚 Production 状态与统计；scramble 无 PE 可删', async () => {
    await seedProductionItem('item-bq', 25);
    const taskId = await answerProductionPass('item-bq');
    expect(db.select().from(dailyStats).get()).toMatchObject({
      formalTasksCompleted: 1,
      productionAttempts: 1,
      productionPass: 1,
    });

    const res = reportBadQuestion(db, taskId, new Date(NOW.getTime() + 120_000), TZ);
    expect(res.ok).toBe(true);
    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'item-bq'))
      .all()
      .find((r) => r.dimension === 'production')!;
    expect(p.reps).toBe(4);
    expect(db.select().from(dailyStats).get()).toMatchObject({
      formalTasksCompleted: 0,
      productionAttempts: 0,
      productionPass: 0,
    });
  });

  it.each([
    { tokens: (id: string) => refTokensFor(id), result: 'pass' as const, productionPass: 1 },
    {
      tokens: (_id: string) => ['wrong', 'order'],
      result: 'fail' as const,
      productionPass: 0,
    },
  ])('bad-question：$result 回减表达统计且重复请求不重复扣减', async (testCase) => {
    await seedProductionItem('item-stats', 25);
    const d = deps();
    await startTodaySession(db, d, TZ, NOW);
    const task = db.select().from(reviewTasks).all()[0]!;
    await answerTodayTask(db, d, TZ, NOW, task.id, {
      selectedTokens: testCase.tokens('item-stats'),
    });
    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.result).toBe(testCase.result);
    expect(db.select().from(dailyStats).get()).toMatchObject({
      formalTasksCompleted: 1,
      productionAttempts: 1,
      productionPass: testCase.productionPass,
    });

    const undoneAt = new Date(NOW.getTime() + 120_000);
    for (let request = 0; request < 2; request++) {
      expect(reportBadQuestion(db, task.id, undoneAt, TZ).ok).toBe(true);
      expect(db.select().from(dailyStats).get()).toMatchObject({
        formalTasksCompleted: 0,
        productionAttempts: 0,
        productionPass: 0,
      });
      expect(db.select().from(attempts).where(eq(attempts.id, attempt.id)).get()).toMatchObject({
        result: 'void',
        voidedAt: undoneAt.toISOString(),
      });
    }
  });
});

describe('scramble 无 AI 批改窗口（断连语义）', () => {
  it('本地判定同步结算：无 evaluateProduction 挂起窗口；requestDisconnected 仍可用', async () => {
    await seedProductionItem('item-sync', 25);
    const d = deps();
    await startTodaySession(db, d, TZ, NOW);
    const task = db.select().from(reviewTasks).all()[0]!;
    let disconnected = false;
    const res = await answerTodayTask(
      db,
      d,
      TZ,
      NOW,
      task.id,
      { selectedTokens: refTokensFor('item-sync') },
      () => NOW,
      () => disconnected,
    );
    expect(res.result).toBe('pass');
    expect(db.select().from(attempts).all()).toHaveLength(1);
  });

  it('requestDisconnected（路由接线纯函数）', () => {
    expect(requestDisconnected({ socket: { destroyed: false } })).toBe(false);
    expect(requestDisconnected({})).toBe(false);
    expect(requestDisconnected({ socket: null })).toBe(false);
    expect(requestDisconnected({ socket: { destroyed: false }, destroyed: true })).toBe(false);
    expect(requestDisconnected({ socket: { destroyed: true } })).toBe(true);
  });
});
