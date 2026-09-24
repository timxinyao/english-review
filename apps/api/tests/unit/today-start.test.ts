import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  dailyStats,
  questions,
  reviewSessions,
  reviewTasks,
  settings,
} from '../../src/db/schema.js';
import type { learningItems } from '../../src/db/schema.js';
import {
  answerTodayTask,
  getTodayStatus,
  startTodaySession,
  type TodayDeps,
} from '../../src/modules/today/service.js';
import { seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';
import { choicePayload, createFakeDeps, DEFAULT_OPTIONS } from '../helpers/today-fakes.js';

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

describe('GET 状态：三态映射（getTodayStatus）', () => {
  it('无 session → idle：dueItems 按 item×维度计数，newTodayAvailable 为默认额度', async () => {
    await seedDueItem('item-a', ['understanding']);
    await seedDueItem('item-b', ['understanding', 'production']);
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
    expect(res.currentTask?.question).toMatchObject({ questionId: expect.any(String) });
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
    await seedDueItem('item-b', ['understanding', 'production']);
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
      expect(lt.questionId).not.toBeNull();
    }
    expect(tasks.filter((t) => t.taskType === 'understanding')).toHaveLength(2);
    expect(tasks.filter((t) => t.taskType === 'cloze')).toHaveLength(1);

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

  it('learn 任务关联首道 understanding 题', async () => {
    await seedNewItem('new-1', '2026-09-01T00:00:00.000Z');
    await startTodaySession(db, deps, TZ, NOW);
    const learn = db
      .select()
      .from(reviewTasks)
      .all()
      .find((t) => t.taskType === 'learn');
    expect(learn?.questionId).toBeTruthy();
    const question = db.select().from(questions).where(eq(questions.id, learn!.questionId!)).get();
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

  it('Learn 题生成失败：跳过该 item、不占额度、不让 start 失败', async () => {
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
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.learningItemId).toBe('new-2');
  });

  it('到期任务无题且生成失败：跳过该任务，其余任务正常', async () => {
    await seedDueItem('item-a', ['understanding']);
    // item-b 到期但无题
    await seedItem(db, { id: 'item-b', target: 'item-b', queueState: 'started' });
    await seedReviewState(db, 'item-b', 'understanding', { level: 2, nextReviewAt: YESTERDAY_ISO });
    const failing = createFakeDeps({ generateFailFor: new Set(['item-b:understanding']) });

    const res = await startTodaySession(db, failing, TZ, NOW);
    expect(res.status).toBe('active');
    const tasks = db.select().from(reviewTasks).all();
    expect(tasks.map((t) => t.learningItemId)).toEqual(['item-a']);
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
    expect(db.select().from(reviewSessions).all()[0]?.completedAt).not.toBeNull();
  });

  it('已完成的当日 session：start 幂等返回 completed 状态', async () => {
    await seedDueItem('item-a', ['understanding']);
    await startTodaySession(db, deps, TZ, NOW);
    const session = sessionOf(TODAY);
    db.update(reviewSessions)
      .set({ completedAt: NOW.toISOString() })
      .where(eq(reviewSessions.id, session!.id))
      .run();
    const res = await startTodaySession(db, deps, TZ, NOW);
    expect(res.status).toBe('completed');
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
