import { beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { createDatabase, rawSqlite, type AppDatabase } from '../../src/db/client.js';
import { withJobLock } from '../../src/db/job-lock.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  dailyStats,
  questions,
  reviewSessions,
  reviewTasks,
  settings,
} from '../../src/db/schema.js';
import { learningItems } from '../../src/db/schema.js';
import {
  answerTodayTask,
  extendTodaySession,
  getTodayStatus,
  prepareTodayTask,
  startTodaySession,
  type TodayDeps,
} from '../../src/modules/today/service.js';
import { seedExample, seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';
import { choicePayload, createFakeDeps, DEFAULT_OPTIONS } from '../helpers/today-fakes.js';
import { updateLearningItem } from '../../src/modules/learning-items/service.js';
import { generateQuestionsForItem } from '../../src/modules/questions/service.js';
import { createMockProvider } from '../../src/ai/provider/index.js';
import { buildMockRuntime } from '../helpers/ai.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-09-24T02:00:00.000Z'); // 上海 2026-09-24 10:00
const TOMORROW = new Date('2026-09-25T02:00:00.000Z');
const YESTERDAY_ISO = '2026-09-23T00:00:00.000Z';
const FUTURE_ISO = '2026-10-01T00:00:00.000Z';
const TODAY = '2026-09-24';

let db: AppDatabase;
let deps: TodayDeps;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
  deps = createFakeDeps();
});

describe('V2 pending task binding', () => {
  it('creates all 100 due tasks without waiting for a blocked generator', async () => {
    for (let i = 0; i < 100; i += 1) {
      await seedItem(db, { id: `due-${i}`, target: `due-${i}`, queueState: 'started' });
      await seedReviewState(db, `due-${i}`, 'understanding', {
        level: 2,
        nextReviewAt: YESTERDAY_ISO,
      });
      if (i > 0) await seedQuestion(db, `due-${i}`, { type: 'understanding' });
    }
    let release!: () => void;
    const blocked = {
      ...deps,
      generate: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const result = await Promise.race([
      startTodaySession(db, blocked, TZ, NOW),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 200)),
    ]);
    if (release) release();
    expect(result).not.toBe('timeout');
    if (result === 'timeout' || result.status !== 'active') return;
    expect(result.progress).toEqual({ completed: 0, total: 100 });
    expect(db.select().from(reviewTasks).all()).toHaveLength(100);
    expect(
      db
        .select()
        .from(reviewTasks)
        .all()
        .every((task) => task.questionId === null),
    ).toBe(true);
  });

  it('leaves failed preparation pending and binds one question on retry', async () => {
    await seedItem(db, { id: 'pending', target: 'pending', queueState: 'started' });
    await seedReviewState(db, 'pending', 'understanding', {
      level: 2,
      nextReviewAt: YESTERDAY_ISO,
    });
    const started = await startTodaySession(db, deps, TZ, NOW);
    if (started.status !== 'active') throw new Error('expected active');
    const taskId = started.currentTask!.taskId;
    const failing = createFakeDeps({ generateFailFor: new Set(['pending:understanding']) });
    await expect(prepareTodayTask(db, failing, TZ, NOW, taskId)).rejects.toMatchObject({
      code: 'AI_PROVIDER_ERROR',
    });
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get()?.questionId,
    ).toBeNull();
    expect(getTodayStatus(db, TZ, NOW).status).toBe('active');
    const prepared = await prepareTodayTask(db, deps, TZ, NOW, taskId);
    expect(prepared.question).toMatchObject({ questionId: expect.any(String) });
    expect((await prepareTodayTask(db, deps, TZ, NOW, taskId)).question).toEqual(prepared.question);
  });

  it('rejects expired, canceled, and effective-goal-off tasks without binding', async () => {
    await seedDueItem('production-off', ['production'], { type: 'chunk' });
    const started = await startTodaySession(db, deps, TZ, NOW);
    if (started.status !== 'active') throw new Error('expected active');
    const taskId = started.currentTask!.taskId;
    await expect(prepareTodayTask(db, deps, TZ, TOMORROW, taskId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    db.update(learningItems)
      .set({ productionEnabledOverride: 0 })
      .where(eq(learningItems.id, 'production-off'))
      .run();
    await expect(prepareTodayTask(db, deps, TZ, NOW, taskId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    db.update(learningItems)
      .set({ productionEnabledOverride: 1 })
      .where(eq(learningItems.id, 'production-off'))
      .run();
    db.update(reviewTasks)
      .set({ canceledAt: NOW.toISOString() })
      .where(eq(reviewTasks.id, taskId))
      .run();
    await expect(prepareTodayTask(db, deps, TZ, NOW, taskId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get()?.questionId,
    ).toBeNull();
  });

  it('refuses a stale meaning snapshot and keeps the task pending for a later retry', async () => {
    await seedDueItem('stale', ['understanding']);
    const started = await startTodaySession(db, deps, TZ, NOW);
    if (started.status !== 'active') throw new Error('expected active');
    const taskId = started.currentTask!.taskId;
    db.update(learningItems)
      .set({ meaning: 'new meaning' })
      .where(eq(learningItems.id, 'stale'))
      .run();
    await expect(prepareTodayTask(db, deps, TZ, NOW, taskId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get()?.questionId,
    ).toBeNull();
  });

  it('rejects a target edit during generation and retires the late old-target question', async () => {
    await seedItem(db, { id: 'target-race', target: 'old target', queueState: 'started' });
    await seedExample(db, 'target-race', 'source', 'The old target appears here.');
    await seedReviewState(db, 'target-race', 'understanding', {
      level: 2,
      nextReviewAt: YESTERDAY_ISO,
    });
    const started = await startTodaySession(db, deps, TZ, NOW);
    if (started.status !== 'active') throw new Error('expected active');
    const taskId = started.currentTask!.taskId;
    let entered!: () => void;
    const generating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing: TodayDeps = {
      ...deps,
      async generate(generateDb, itemId) {
        const oldTarget = generateDb
          .select()
          .from(learningItems)
          .where(eq(learningItems.id, itemId))
          .get()!.target;
        entered();
        await blocked;
        await seedQuestion(generateDb, itemId, {
          id: 'late-old-question',
          type: 'understanding',
          promptText: `Meaning of ${oldTarget}?`,
          payloadJson: choicePayload(DEFAULT_OPTIONS),
          correctOptionId: 'o1',
        });
      },
    };
    const preparation = prepareTodayTask(db, racing, TZ, NOW, taskId);
    await generating;
    await updateLearningItem(db, 'target-race', { target: 'new target' }, TZ);
    release();
    await expect(preparation).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get()?.questionId,
    ).toBeNull();
    expect(
      db.select().from(questions).where(eq(questions.id, 'late-old-question')).get()?.status,
    ).toBe('retired');
    const retry = await prepareTodayTask(db, deps, TZ, NOW, taskId);
    expect(retry.question?.questionId).not.toBe('late-old-question');
  });

  it('preserves a real generator target-edit conflict as 409 instead of an AI failure', async () => {
    await seedItem(db, { id: 'target-race-real', target: 'old target', queueState: 'started' });
    await seedExample(db, 'target-race-real', 'source', 'The old target appears here.');
    await seedReviewState(db, 'target-race-real', 'understanding', {
      level: 2,
      nextReviewAt: YESTERDAY_ISO,
    });
    const started = await startTodaySession(db, deps, TZ, NOW);
    if (started.status !== 'active') throw new Error('expected active');
    const taskId = started.currentTask!.taskId;
    const inner = createMockProvider();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = buildMockRuntime({
      name: inner.name,
      async complete(request) {
        enter();
        await blocked;
        return inner.complete(request);
      },
    });
    const realGeneratorDeps: TodayDeps = {
      ...deps,
      generate: (generateDb, itemId, type) =>
        generateQuestionsForItem({ db: generateDb, runtime }, itemId, type, 1),
    };
    const preparation = prepareTodayTask(db, realGeneratorDeps, TZ, NOW, taskId);
    await entered;
    await updateLearningItem(db, 'target-race-real', { target: 'new target' }, TZ);
    release();
    await expect(preparation).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get()?.questionId,
    ).toBeNull();
    expect(db.select().from(questions).all()).toHaveLength(0);
  });
});

async function seedDueItem(
  itemId: string,
  dims: Array<'understanding' | 'production'>,
  overrides: Partial<typeof learningItems.$inferInsert> = {},
): Promise<string> {
  await seedItem(db, { id: itemId, target: itemId, queueState: 'started', ...overrides });
  for (const dim of dims) {
    await seedReviewState(db, itemId, dim, {
      level: dim === 'understanding' ? 3 : 1,
      nextReviewAt: YESTERDAY_ISO,
    });
    await seedQuestion(db, itemId, {
      type: dim === 'understanding' ? 'understanding' : 'cloze',
      payloadJson:
        dim === 'understanding'
          ? choicePayload(DEFAULT_OPTIONS)
          : JSON.stringify({ acceptedAnswers: [itemId] }),
      correctOptionId: dim === 'understanding' ? 'o1' : null,
      contextText: dim === 'understanding' ? 'A ____ sentence.' : 'Use the ____ here.',
    });
  }
  return itemId;
}

async function seedNewItem(itemId: string, createdAt: string): Promise<string> {
  await seedItem(db, { id: itemId, target: itemId, queueState: 'new', createdAt });
  await seedQuestion(db, itemId, {
    type: 'understanding',
    payloadJson: choicePayload(DEFAULT_OPTIONS),
    correctOptionId: 'o1',
    contextText: '____ fills the blank.',
  });
  return itemId;
}

function setMaxNewItemsPerDay(v: number): void {
  db.insert(settings)
    .values({
      id: 1,
      maxNewItemsPerDay: v,
      contentLevel: 'B1',
      preferredTtsVoice: null,
      updatedAt: new Date().toISOString(),
    })
    .run();
}

function sessionOf(date: string) {
  return db.select().from(reviewSessions).where(eq(reviewSessions.sessionDate, date)).get();
}

/** 今日已开始学习数（extend / remainingNewQuota 的额度扣减依据） */
function seedStats(newItemsStarted: number): void {
  db.insert(dailyStats)
    .values({
      date: TODAY,
      formalTasksCompleted: newItemsStarted,
      newItemsStarted,
      productionAttempts: 0,
      productionPass: 0,
      updatedAt: NOW.toISOString(),
    })
    .run();
}

/** 构造已完成会话：start（单个到期任务）后把任务与会话一并标记完成（手法同「session 已完成 → completed 摘要」用例） */
async function seedCompletedSession(): Promise<string> {
  await seedDueItem('done-item', ['understanding']);
  await startTodaySession(db, deps, TZ, NOW);
  const session = sessionOf(TODAY)!;
  db.update(reviewTasks)
    .set({ completedAt: NOW.toISOString() })
    .where(eq(reviewTasks.sessionId, session.id))
    .run();
  db.update(reviewSessions)
    .set({ completedAt: NOW.toISOString() })
    .where(eq(reviewSessions.id, session.id))
    .run();
  return session.id;
}

describe('GET 状态：三态映射（getTodayStatus）', () => {
  it('无 session → idle：dueItems 按 item×维度计数，newTodayAvailable 为默认额度', async () => {
    await seedDueItem('item-a', ['understanding']);
    await seedDueItem('item-b', ['understanding', 'production'], { type: 'chunk' });
    for (let i = 0; i < 12; i++) await seedNewItem(`new-${i}`, `2026-09-01T00:00:0${i % 10}.000Z`);

    const res = getTodayStatus(db, TZ, NOW);
    expect(res.status).toBe('idle');
    if (res.status !== 'idle') return;
    expect(res.dueItems).toBe(3); // a:U + b:U + b:P
    expect(res.newTodayAvailable).toBe(10); // 候选 12 > 默认额度，取额度
  });

  it('New Queue 候选不足额度 → newTodayAvailable 取候选数', async () => {
    await seedNewItem('only-1', '2026-09-01T00:00:00.000Z');
    const res = getTodayStatus(db, TZ, NOW);
    expect(res.status).toBe('idle');
    if (res.status !== 'idle') return;
    expect(res.newTodayAvailable).toBe(1);
  });

  it('额度 -1（不限制）→ newTodayAvailable 给 New Queue 候选数', async () => {
    setMaxNewItemsPerDay(-1);
    await seedNewItem('new-1', '2026-09-01T00:00:00.000Z');
    await seedNewItem('new-2', '2026-09-02T00:00:00.000Z');
    await seedNewItem('new-3', '2026-09-03T00:00:00.000Z');

    const res = getTodayStatus(db, TZ, NOW);
    expect(res.status).toBe('idle');
    if (res.status !== 'idle') return;
    expect(res.newTodayAvailable).toBe(3);
  });

  it('当日已完成 Learn → 剩余额度扣减', async () => {
    db.insert(dailyStats)
      .values({
        date: TODAY,
        formalTasksCompleted: 3,
        newItemsStarted: 3,
        productionAttempts: 0,
        productionPass: 0,
        updatedAt: NOW.toISOString(),
      })
      .run();
    for (let i = 0; i < 12; i++) await seedNewItem(`new-${i}`, `2026-09-02T00:00:0${i % 10}.000Z`);
    const res = getTodayStatus(db, TZ, NOW);
    expect(res.status).toBe('idle');
    if (res.status !== 'idle') return;
    expect(res.newTodayAvailable).toBe(7); // 候选充足，剩余额度 10-3
  });

  it('dueItems 排除 stable 维度与非 active / 非 started 项', async () => {
    await seedDueItem('paused-item', ['understanding'], { status: 'paused' });
    await seedDueItem('archived-item', ['understanding'], { status: 'archived' });
    await seedDueItem('queued-item', ['understanding'], { queueState: 'new' });
    await seedItem(db, { id: 'stable-item', target: 'stable-item', queueState: 'started' });
    await seedReviewState(db, 'stable-item', 'understanding', {
      level: 7,
      stable: 1,
      nextReviewAt: YESTERDAY_ISO,
    });

    const res = getTodayStatus(db, TZ, NOW);
    if (res.status !== 'idle') throw new Error('应处于 idle');
    expect(res.dueItems).toBe(0);
  });

  it('recentlyLearned：无 Learn 历史时取最近创建的 started 项（≤5）', async () => {
    for (let i = 1; i <= 7; i += 1) {
      await seedItem(db, {
        id: `s-${i}`,
        target: `s-${i}`,
        queueState: 'started',
        createdAt: `2026-09-0${i}T00:00:00.000Z`,
      });
    }
    const res = getTodayStatus(db, TZ, NOW);
    if (res.status !== 'idle') throw new Error('应处于 idle');
    expect(res.recentlyLearned.map((x) => x.id)).toEqual(['s-7', 's-6', 's-5', 's-4', 's-3']);
  });

  it('session 未完成 → active；currentTask 为 sortKey 最小的未完成任务', async () => {
    await seedDueItem('item-a', ['understanding']);
    const started = await startTodaySession(db, deps, TZ, NOW);
    expect(started.status).toBe('active');

    const res = getTodayStatus(db, TZ, NOW);
    expect(res.status).toBe('active');
    if (res.status !== 'active') return;
    expect(res.session.sessionDate).toBe(TODAY);
    expect(res.progress).toEqual({ completed: 0, total: 1 });
    expect(res.currentTask?.item.id).toBe('item-a');
    expect(res.currentTask?.question).toBeNull();
  });

  it('session 已完成 → completed 摘要', async () => {
    await seedDueItem('item-a', ['understanding']);
    await startTodaySession(db, deps, TZ, NOW);
    const session = sessionOf(TODAY);
    db.update(reviewTasks)
      .set({ completedAt: NOW.toISOString() })
      .where(eq(reviewTasks.sessionId, session!.id))
      .run();
    db.update(reviewSessions)
      .set({ completedAt: NOW.toISOString() })
      .where(eq(reviewSessions.id, session!.id))
      .run();

    const res = getTodayStatus(db, TZ, NOW);
    expect(res.status).toBe('completed');
    if (res.status !== 'completed') return;
    expect(res.summary.totalTasks).toBe(1);
    expect(res.summary.recommendRead).toBe(false);
  });
});

describe('POST start：session 创建与幂等', () => {
  it('创建 base 任务（到期维度）+ Learn 任务（额度内），混排 sortKey 为递增整数', async () => {
    setMaxNewItemsPerDay(2);
    await seedDueItem('item-a', ['understanding']);
    await seedDueItem('item-b', ['understanding', 'production'], { type: 'chunk' });
    await seedNewItem('new-1', '2026-09-01T00:00:00.000Z');
    await seedNewItem('new-2', '2026-09-02T00:00:00.000Z');
    await seedNewItem('new-3', '2026-09-03T00:00:00.000Z'); // 超出额度

    const res = await startTodaySession(db, deps, TZ, NOW);
    expect(res.status).toBe('active');

    const tasks = db.select().from(reviewTasks).all();
    expect(tasks).toHaveLength(5); // a:U + b:U + b:P + learn×2
    expect([...tasks].map((t) => t.sortKey).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);

    const learnTasks = tasks.filter((t) => t.taskType === 'learn');
    expect(learnTasks.map((t) => t.learningItemId).sort()).toEqual(['new-1', 'new-2']);
    for (const lt of learnTasks) {
      expect(lt.dimension).toBe('understanding');
      expect(lt.questionId).toBeNull();
    }
    expect(tasks.filter((t) => t.taskType === 'understanding')).toHaveLength(2);
    expect(tasks.filter((t) => t.taskType === 'production')).toHaveLength(1);
    expect(tasks.filter((t) => t.taskType === 'cloze')).toHaveLength(0);

    // 同一 item（item-b 的 U+P）不相邻
    const sorted = [...tasks].sort((x, y) => x.sortKey - y.sortKey);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.learningItemId).not.toBe(sorted[i - 1]!.learningItemId);
    }

    const session = db.select().from(reviewSessions).get();
    expect(session?.sessionDate).toBe(TODAY);
    expect(session?.baseTaskCount).toBe(5);
    expect(session?.completedAt).toBeNull();
  });

  it('learn 任务准备后关联首道 understanding 题', async () => {
    await seedNewItem('new-1', '2026-09-01T00:00:00.000Z');
    await startTodaySession(db, deps, TZ, NOW);
    const learn = db
      .select()
      .from(reviewTasks)
      .all()
      .find((t) => t.taskType === 'learn');
    expect(learn?.questionId).toBeNull();
    await prepareTodayTask(db, deps, TZ, NOW, learn!.id);
    const bound = db.select().from(reviewTasks).where(eq(reviewTasks.id, learn!.id)).get();
    const question = db.select().from(questions).where(eq(questions.id, bound!.questionId!)).get();
    expect(question?.type).toBe('understanding');
  });

  it('幂等：当日再次 start 返回同一 session，不新增任务', async () => {
    await seedDueItem('item-a', ['understanding']);
    const first = await startTodaySession(db, deps, TZ, NOW);
    const second = await startTodaySession(
      db,
      createFakeDeps(),
      TZ,
      new Date(NOW.getTime() + 3600_000),
    );
    expect(first.status).toBe('active');
    expect(second.status).toBe('active');
    if (first.status !== 'active' || second.status !== 'active') return;
    expect(second.session.id).toBe(first.session.id);
    expect(db.select().from(reviewTasks).all()).toHaveLength(1);
    expect(db.select().from(reviewSessions).all()).toHaveLength(1);
  });

  it('当日额度跨日重置：第二天 start 建新 session 且额度恢复', async () => {
    setMaxNewItemsPerDay(1);
    await seedNewItem('new-1', '2026-09-01T00:00:00.000Z');
    await seedNewItem('new-2', '2026-09-02T00:00:00.000Z');

    const day1 = await startTodaySession(db, deps, TZ, NOW);
    if (day1.status !== 'active') throw new Error('day1 应为 active');
    expect(db.select().from(reviewTasks).all()).toHaveLength(1);
    // 完成 day1 的 Learn：new-1 → started，day1 额度耗尽
    const learn = db.select().from(reviewTasks).all()[0]!;
    await prepareTodayTask(db, deps, TZ, NOW, learn.id);
    await answerTodayTask(db, deps, TZ, NOW, learn.id, { selectedOptionId: 'o1' });

    const day2 = await startTodaySession(db, createFakeDeps(), TZ, TOMORROW);
    if (day2.status !== 'active') throw new Error('day2 应为 active');
    expect(day2.session.sessionDate).toBe('2026-09-25');
    expect(db.select().from(reviewSessions).all()).toHaveLength(2);
    // 新的一天额度重置：new-2 可再学一个
    const day2Learn = db
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.sessionId, day2.session.id), eq(reviewTasks.taskType, 'learn')))
      .all();
    expect(day2Learn).toHaveLength(1);
    expect(day2Learn[0]!.learningItemId).toBe('new-2');
  });

  it('中途放弃后重入：同日 start 恢复原 session，不重复建任务', async () => {
    setMaxNewItemsPerDay(2);
    await seedNewItem('new-1', '2026-09-01T00:00:00.000Z');
    await seedNewItem('new-2', '2026-09-02T00:00:00.000Z');
    const first = await startTodaySession(db, deps, TZ, NOW);
    if (first.status !== 'active') throw new Error('应为 active');
    // 放弃（不答题）
    const again = await startTodaySession(
      db,
      createFakeDeps(),
      TZ,
      new Date(NOW.getTime() + 3600_000),
    );
    expect(again.status).toBe('active');
    if (again.status !== 'active') return;
    expect(again.session.id).toBe(first.session.id);
    expect(db.select().from(reviewTasks).all()).toHaveLength(2);
    // 未完成任何 Learn → daily_stats 不计额度
    expect(db.select().from(dailyStats).all()).toHaveLength(0);
  });

  it('Learn 题生成失败：pending item 保留在 session 中', async () => {
    setMaxNewItemsPerDay(2);
    await seedItem(db, {
      id: 'new-empty',
      target: 'new-empty',
      queueState: 'new',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await seedNewItem('new-2', '2026-09-02T00:00:00.000Z');
    const failing = createFakeDeps({ generateFailFor: new Set(['new-empty:understanding']) });

    const res = await startTodaySession(db, failing, TZ, NOW);
    expect(res.status).toBe('active');
    const tasks = db.select().from(reviewTasks).all();
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.learningItemId)).toEqual(['new-empty', 'new-2']);
    expect(tasks.every((task) => task.questionId === null)).toBe(true);
  });

  it('到期任务无题且生成失败：任务仍计入进度', async () => {
    await seedDueItem('item-a', ['understanding']);
    // item-b 到期但无题
    await seedItem(db, { id: 'item-b', target: 'item-b', queueState: 'started' });
    await seedReviewState(db, 'item-b', 'understanding', { level: 2, nextReviewAt: YESTERDAY_ISO });
    const failing = createFakeDeps({ generateFailFor: new Set(['item-b:understanding']) });

    const res = await startTodaySession(db, failing, TZ, NOW);
    expect(res.status).toBe('active');
    const tasks = db.select().from(reviewTasks).all();
    expect(tasks.map((t) => t.learningItemId)).toEqual(['item-a', 'item-b']);
  });

  it('无到期且无可学 → 空会话直接 completed', async () => {
    const res = await startTodaySession(db, deps, TZ, NOW);
    expect(res.status).toBe('completed');
    if (res.status !== 'completed') return;
    expect(res.summary).toEqual({
      totalTasks: 0,
      pass: 0,
      basicPass: 0,
      fail: 0,
      newItemsStarted: 0,
      recommendRead: false,
    });
    // 与 getTodayStatus 一致：completed 响应必须带剩余额度（默认额度 10、今日未学）
    expect(res.remainingNewQuota).toBe(10);
    expect(db.select().from(reviewSessions).all()[0]?.completedAt).not.toBeNull();
  });

  it('已完成的当日 session：start 幂等返回 completed 状态（含 remainingNewQuota）', async () => {
    await seedDueItem('item-a', ['understanding']);
    await startTodaySession(db, deps, TZ, NOW);
    const session = sessionOf(TODAY);
    db.update(reviewSessions)
      .set({ completedAt: NOW.toISOString() })
      .where(eq(reviewSessions.id, session!.id))
      .run();
    const res = await startTodaySession(db, deps, TZ, NOW);
    expect(res.status).toBe('completed');
    if (res.status !== 'completed') return;
    expect(res.remainingNewQuota).toBe(10);
    expect(res.totalItems).toBeGreaterThan(0);
    expect(res.newQueueCount).toBeGreaterThanOrEqual(0);
  });
});

describe('due 查询边界', () => {
  it('next_review_at 恰好等于 now 视为到期；未到期不算', async () => {
    await seedItem(db, { id: 'exact', target: 'exact', queueState: 'started' });
    await seedReviewState(db, 'exact', 'understanding', {
      level: 2,
      nextReviewAt: NOW.toISOString(),
    });
    await seedItem(db, { id: 'future', target: 'future', queueState: 'started' });
    await seedReviewState(db, 'future', 'understanding', { level: 2, nextReviewAt: FUTURE_ISO });

    const res = getTodayStatus(db, TZ, NOW);
    if (res.status !== 'idle') throw new Error('应处于 idle');
    expect(res.dueItems).toBe(1);
  });
});

describe('prepare 并发安全与 start 非阻塞', () => {
  it('start 保持到期顺序，两个同时 prepare 只绑定同一个题目', async () => {
    const ids = ['item-1', 'item-2', 'item-3'];
    for (const [i, id] of ids.entries()) {
      await seedItem(db, { id, target: id, queueState: 'started' });
      await seedReviewState(db, id, 'understanding', {
        level: 2,
        nextReviewAt: new Date(Date.parse(YESTERDAY_ISO) + i * 60_000).toISOString(),
      });
    }

    const res = await startTodaySession(db, deps, TZ, NOW);
    expect(res.status).toBe('active');
    const tasks = db.select().from(reviewTasks).orderBy(asc(reviewTasks.sortKey)).all();
    expect(tasks.map((t) => t.learningItemId)).toEqual(['item-1', 'item-2', 'item-3']);
    const [first, second] = await Promise.all([
      prepareTodayTask(db, deps, TZ, NOW, tasks[0]!.id),
      prepareTodayTask(db, deps, TZ, NOW, tasks[0]!.id),
    ]);
    expect(first.question?.questionId).toBe(second.question?.questionId);
    expect(
      db.select().from(questions).where(eq(questions.learningItemId, 'item-1')).all(),
    ).toHaveLength(1);
  });

  it('全局生成锁被占时 start 仍创建 pending 会话，prepare 等锁释放', async () => {
    await seedNewItem('new-lock', '2026-09-01T00:00:00.000Z');
    const holder = withJobLock(db, 'question-generation', async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    const res = await startTodaySession(db, deps, TZ, NOW);
    expect(db.select().from(reviewSessions).all()).toHaveLength(1);
    if (res.status !== 'active') throw new Error('expected active');
    const prepared = await prepareTodayTask(db, deps, TZ, NOW, res.currentTask!.taskId);
    await holder;
    expect(prepared.question?.questionId).toBeTruthy();
    const locks = rawSqlite(db).prepare('SELECT COUNT(*) n FROM job_locks').get() as { n: number };
    expect(locks.n).toBe(0);
  });
});

describe('extendTodaySession（同日追加学习）', () => {
  function learnTasks(): Array<typeof reviewTasks.$inferSelect> {
    return db
      .select()
      .from(reviewTasks)
      .orderBy(asc(reviewTasks.sortKey))
      .all()
      .filter((t) => t.taskType === 'learn');
  }

  it('成功：已完成会话+剩余额度 → 追加 learn 任务、completedAt 清空、返回 active', async () => {
    const sessionId = await seedCompletedSession();
    setMaxNewItemsPerDay(20);
    seedStats(10); // 剩余额度 10 > 队列 3 → 全取
    await seedNewItem('new-1', '2026-09-01T00:00:00.000Z');
    await seedNewItem('new-2', '2026-09-02T00:00:00.000Z');
    await seedNewItem('new-3', '2026-09-03T00:00:00.000Z');

    const res = await extendTodaySession(db, deps, TZ, NOW);
    expect(res.status).toBe('active');
    if (res.status !== 'active') return;
    expect(res.session.id).toBe(sessionId);
    expect(res.session.sessionDate).toBe(TODAY);
    // 原 1 个已完成任务 + 3 个新 learn
    expect(res.progress).toEqual({ completed: 1, total: 4 });
    expect(res.currentTask?.taskType).toBe('learn');

    const learn = learnTasks();
    expect(learn.map((t) => t.learningItemId)).toEqual(['new-1', 'new-2', 'new-3']);
    // sortKey 接最大值递增（此前唯一任务 sortKey=1）
    expect(learn.map((t) => t.sortKey)).toEqual([2, 3, 4]);
    for (const lt of learn) {
      expect(lt.origin).toBe('base');
      expect(lt.dimension).toBe('understanding');
      expect(lt.questionId).toBeNull();
      expect(lt.completedAt).toBeNull();
      expect(lt.canceledAt).toBeNull();
    }

    expect(sessionOf(TODAY)!.completedAt).toBeNull();
    expect(getTodayStatus(db, TZ, NOW).status).toBe('active');
  });

  it('额度用尽 → CONFLICT "今日新学习额度已用完"，会话保持完成', async () => {
    await seedCompletedSession();
    setMaxNewItemsPerDay(10);
    seedStats(10);
    await seedNewItem('new-1', '2026-09-01T00:00:00.000Z');

    await expect(extendTodaySession(db, deps, TZ, NOW)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: '今日新学习额度已用完',
    });
    expect(sessionOf(TODAY)!.completedAt).not.toBeNull();
    expect(db.select().from(reviewTasks).all()).toHaveLength(1);
  });

  it('会话未完成 → CONFLICT（active 会话无需 extend）', async () => {
    await seedDueItem('item-a', ['understanding']);
    await startTodaySession(db, deps, TZ, NOW);
    await expect(extendTodaySession(db, deps, TZ, NOW)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: '会话尚未完成，无需追加',
    });
  });

  it('今日无会话 → CONFLICT', async () => {
    await expect(extendTodaySession(db, deps, TZ, NOW)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: '今日没有复习会话',
    });
  });

  it('不限制模式：批 10 个（队列 12 词只取前 10，其余保持 new）', async () => {
    await seedCompletedSession();
    setMaxNewItemsPerDay(-1);
    for (let i = 0; i < 12; i += 1) {
      await seedNewItem(`new-${i}`, `2026-09-01T00:00:${String(i).padStart(2, '0')}.000Z`);
    }

    const res = await extendTodaySession(db, deps, TZ, NOW);
    expect(res.status).toBe('active');
    const learn = learnTasks();
    expect(learn).toHaveLength(10);
    expect(learn.map((t) => t.learningItemId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `new-${i}`),
    );
    expect(learn.map((t) => t.sortKey)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // extend 不改 queue_state（由 Learn 作答结算推进）：12 个词此刻都仍是 new
    const stillNew = db
      .select()
      .from(learningItems)
      .where(eq(learningItems.queueState, 'new'))
      .all();
    expect(stillNew).toHaveLength(12);
  });

  it('剩余额度小于队列：只取剩余数', async () => {
    await seedCompletedSession();
    setMaxNewItemsPerDay(12);
    seedStats(10); // 剩 2
    for (let i = 1; i <= 5; i += 1) {
      await seedNewItem(`new-${i}`, `2026-09-0${i}T00:00:00.000Z`);
    }

    const res = await extendTodaySession(db, deps, TZ, NOW);
    expect(res.status).toBe('active');
    expect(learnTasks().map((t) => t.learningItemId)).toEqual(['new-1', 'new-2']);
  });

  it('幂等：extend 后会话重新激活，再次 extend → CONFLICT 且不重复追加', async () => {
    await seedCompletedSession();
    setMaxNewItemsPerDay(20);
    seedStats(10);
    await seedNewItem('new-1', '2026-09-01T00:00:00.000Z');

    const first = await extendTodaySession(db, deps, TZ, NOW);
    expect(first.status).toBe('active');
    await expect(extendTodaySession(db, deps, TZ, NOW)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(db.select().from(reviewTasks).all()).toHaveLength(2);
  });

  it('全部新词 Learn 题生成失败 → 追加 pending 任务，prepare 可重试', async () => {
    await seedCompletedSession();
    setMaxNewItemsPerDay(20);
    seedStats(10);
    // 无库存题 → 走 generate 且必失败
    await seedItem(db, {
      id: 'new-x',
      target: 'new-x',
      queueState: 'new',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    const failing = createFakeDeps({ generateFailFor: new Set(['new-x:understanding']) });

    const extended = await extendTodaySession(db, failing, TZ, NOW);
    expect(extended.progress).toEqual({ completed: 1, total: 2 });
    const pending = db
      .select()
      .from(reviewTasks)
      .where(eq(reviewTasks.learningItemId, 'new-x'))
      .get()!;
    expect(pending.questionId).toBeNull();
    await expect(prepareTodayTask(db, failing, TZ, NOW, pending.id)).rejects.toMatchObject({
      code: 'AI_PROVIDER_ERROR',
    });
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.id, pending.id)).get()?.questionId,
    ).toBeNull();
    expect(
      (await prepareTodayTask(db, deps, TZ, NOW, pending.id)).question?.questionId,
    ).toBeTruthy();
  });

  it('New Queue 为空 → CONFLICT 没有可学的新词', async () => {
    await seedCompletedSession();
    setMaxNewItemsPerDay(20);
    seedStats(10);

    await expect(extendTodaySession(db, deps, TZ, NOW)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: '没有可学的新词',
    });
  });
});

describe('completed 响应 remainingNewQuota', () => {
  it('有限剩余：maxNew=20、今日已学 10 → remainingNewQuota=10', async () => {
    await seedCompletedSession();
    setMaxNewItemsPerDay(20);
    seedStats(10);
    const res = getTodayStatus(db, TZ, NOW);
    expect(res.status).toBe('completed');
    if (res.status !== 'completed') return;
    expect(res.remainingNewQuota).toBe(10);
  });

  it('不限制：maxNew=-1 → remainingNewQuota=null', async () => {
    await seedCompletedSession();
    setMaxNewItemsPerDay(-1);
    const res = getTodayStatus(db, TZ, NOW);
    expect(res.status).toBe('completed');
    if (res.status !== 'completed') return;
    expect(res.remainingNewQuota).toBeNull();
  });

  it('用尽：maxNew=10、今日已学 10 → remainingNewQuota=0', async () => {
    await seedCompletedSession();
    setMaxNewItemsPerDay(10);
    seedStats(10);
    const res = getTodayStatus(db, TZ, NOW);
    expect(res.status).toBe('completed');
    if (res.status !== 'completed') return;
    expect(res.remainingNewQuota).toBe(0);
  });
});
