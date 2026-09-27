import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  attempts,
  dailyStats,
  learningItems,
  questions,
  reviewSessions,
  reviewStates,
  reviewTasks,
} from '../../src/db/schema.js';
import {
  answerTodayTask,
  deferTodayTask,
  reportBadQuestion,
  startTodaySession,
  submitTaskFeedback,
  type TodayDeps,
} from '../../src/modules/today/service.js';
import { seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';
import { choicePayload, createFakeDeps, DEFAULT_OPTIONS } from '../helpers/today-fakes.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-09-24T02:00:00.000Z');
const T1 = new Date('2026-09-24T02:01:00.000Z');
const T2 = new Date('2026-09-24T02:02:00.000Z');
const DAY_MS = 24 * 3600 * 1000;

let db: AppDatabase;
let deps: TodayDeps;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
  deps = createFakeDeps();
});

async function seedDueChoiceItem(itemId: string, level = 3): Promise<void> {
  await seedItem(db, { id: itemId, target: itemId, queueState: 'started' });
  await seedReviewState(db, itemId, 'understanding', {
    level,
    nextReviewAt: '2026-09-23T00:00:00.000Z',
  });
  await seedQuestion(db, itemId, {
    type: 'understanding',
    payloadJson: choicePayload(DEFAULT_OPTIONS, '解释'),
    correctOptionId: 'o1',
    contextText: 'A ____ sentence.',
  });
}

async function seedLearnItem(itemId: string): Promise<void> {
  await seedItem(db, {
    id: itemId,
    target: itemId,
    queueState: 'new',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  await seedQuestion(db, itemId, {
    type: 'understanding',
    payloadJson: choicePayload(DEFAULT_OPTIONS),
    correctOptionId: 'o1',
    contextText: '____ fills the blank.',
  });
}

async function startSession(): Promise<string> {
  const res = await startTodaySession(db, deps, TZ, NOW);
  if (res.status !== 'active') throw new Error(`start 失败：${res.status}`);
  return res.session.id;
}

function tasks(): Array<typeof reviewTasks.$inferSelect> {
  return db.select().from(reviewTasks).all();
}

function taskByItem(
  itemId: string,
  opts: { type?: string; origin?: string; pending?: boolean } = {},
) {
  return (
    tasks().find(
      (t) =>
        t.learningItemId === itemId &&
        (opts.type === undefined || t.taskType === opts.type) &&
        (opts.origin === undefined || t.origin === opts.origin) &&
        (!opts.pending || (t.completedAt === null && t.canceledAt === null)),
    ) ?? null
  );
}

function dim(itemId: string, dimension: 'understanding' | 'production') {
  return (
    db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, itemId))
      .all()
      .find((r) => r.dimension === dimension) ?? null
  );
}

function firstAttempt() {
  return db.select().from(attempts).all()[0]!;
}

describe('later（稍后再做）', () => {
  it('defer_count+1、sortKey 移到未完成任务最大 sortKey+1000、不写 attempt', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await seedDueChoiceItem('item-c');
    await startSession();
    const a = taskByItem('item-a')!; // sortKey 1

    const res = deferTodayTask(db, a.id);
    expect(res.ok).toBe(true);
    expect(res.progress).toEqual({ completed: 0, total: 3 }); // 进度不变

    const moved = taskByItem('item-a')!;
    expect(moved.deferCount).toBe(1);
    expect(moved.sortKey).toBe(3 + 1000); // 未完成任务最大 sortKey=3 → 1003
    expect(moved.completedAt).toBeNull();
    expect(db.select().from(attempts).all()).toHaveLength(0);
  });

  it('多次 later：继续后移', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await startSession();
    const a = taskByItem('item-a')!;
    deferTodayTask(db, a.id); // 未完成最大 sortKey=2 → 1002
    deferTodayTask(db, a.id); // 未完成最大 sortKey=1002 → 2002
    const moved = taskByItem('item-a')!;
    expect(moved.deferCount).toBe(2);
    expect(moved.sortKey).toBe(2002);
  });

  it('later 后任务仍是 currentTask 的候选：其他任务先答，later 的最后清空才能完成', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await startSession();
    const a = taskByItem('item-a')!;
    const b = taskByItem('item-b')!;
    deferTodayTask(db, a.id);

    const resB = await answerTodayTask(db, deps, TZ, NOW, b.id, { selectedOptionId: 'o1' });
    expect(resB.completed).toBeNull(); // later 的任务未清空 → 未完成

    const resA = await answerTodayTask(db, deps, TZ, T1, a.id, { selectedOptionId: 'o1' });
    expect(resA.completed).not.toBeNull(); // 清空后完成
  });

  it('已完成/不存在任务 → 409 / 404', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const a = taskByItem('item-a')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { selectedOptionId: 'o1' });
    await expect(async () => deferTodayTask(db, a.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(async () => deferTodayTask(db, 'no-such')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('bad-question（坏题撤销）', () => {
  it('撤销普通作答：快照回滚、attempt void、题目 bad_question、任务取消、stats 回减', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await startSession();
    const a = taskByItem('item-a')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { selectedOptionId: 'o1' }); // 提交选项 = hint 语义 → basic_pass

    const res = reportBadQuestion(db, a.id, T1);
    expect(res.ok).toBe(true);
    expect(res.progress).toEqual({ completed: 0, total: 1 }); // 撤销后 a 不再计入

    // 两维快照回滚：U 回到 L3
    const u = dim('item-a', 'understanding')!;
    expect(u.level).toBe(3);
    expect(u.lastReviewAt).toBeNull();

    // attempt void
    const attempt = firstAttempt();
    expect(attempt.result).toBe('void');
    expect(attempt.voidedAt).toBe(T1.toISOString());

    // 题目坏题 + 任务取消
    expect(db.select().from(questions).where(eq(questions.id, a.questionId!)).get()?.status).toBe(
      'bad_question',
    );
    expect(taskByItem('item-a')!.canceledAt).toBe(T1.toISOString());

    // daily_stats 回减
    const stats = db.select().from(dailyStats).get()!;
    expect(stats.formalTasksCompleted).toBe(0);
  });

  it('撤销 Learn 激活：删除 U/P 行、queue_state 回 new、new_items_started 回减', async () => {
    await seedLearnItem('new-1');
    await startSession();
    const learn = taskByItem('new-1', { type: 'learn' })!;
    await answerTodayTask(db, deps, TZ, NOW, learn.id, { selectedOptionId: 'o1' });

    reportBadQuestion(db, learn.id, T1);

    expect(db.select().from(reviewStates).all()).toHaveLength(0);
    const item = db.select().from(learningItems).where(eq(learningItems.id, 'new-1')).get()!;
    expect(item.queueState).toBe('new');
    const stats = db.select().from(dailyStats).get()!;
    expect(stats.newItemsStarted).toBe(0);
    expect(stats.formalTasksCompleted).toBe(0);
    const session = db.select().from(reviewSessions).get()!;
    expect(session.newItemsStarted).toBe(0);
  });

  it('撤销 fail：取消该 attempt 产生的补强任务', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const a = taskByItem('item-a')!;
    const res = await answerTodayTask(db, deps, TZ, NOW, a.id, { selectedOptionId: 'o2' });
    expect(res.reinforcementAdded).toBe(true);
    const rf = tasks().find((t) => t.origin === 'reinforcement')!;

    reportBadQuestion(db, a.id, T1);

    const rfRow = tasks().find((t) => t.id === rf.id)!;
    expect(rfRow.canceledAt).toBe(T1.toISOString());
    // 状态回滚到 fail 前
    expect(dim('item-a', 'understanding')!.level).toBe(3);
  });

  it('后续已有同 item+维度作答 → 409 拒绝', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const a = taskByItem('item-a')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { selectedOptionId: 'o2' }); // fail → 补强
    const rf = tasks().find((t) => t.origin === 'reinforcement')!;
    await answerTodayTask(db, deps, TZ, T1, rf.id, { selectedOptionId: 'o1' }); // 后续作答

    await expect(async () => reportBadQuestion(db, a.id, T2)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('后续作答'),
    });
  });

  it('未作答任务不能标坏题 → 409；重复撤销幂等返回 ok', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const a = taskByItem('item-a')!;
    await expect(async () => reportBadQuestion(db, a.id, NOW)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    await answerTodayTask(db, deps, TZ, NOW, a.id, { selectedOptionId: 'o1' });
    const first = reportBadQuestion(db, a.id, T1);
    expect(first.ok).toBe(true);
    const second = reportBadQuestion(db, a.id, T2); // 幂等
    expect(second.ok).toBe(true);
    expect(db.select().from(attempts).all()).toHaveLength(1);
  });
});

describe('feedback（答题反馈调整）', () => {
  it('guessed：以 pre 状态按 fail 重算，attempt.result 改 fail', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const a = taskByItem('item-a')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { selectedOptionId: 'o1' }); // hint 语义 → basic_pass

    const res = submitTaskFeedback(db, deps, TZ, a.id, 'guessed', T1);
    expect(res.ok).toBe(true);
    expect(res.adjustedResult).toBe('fail');

    // 从 pre（L3）按 fail 重算 → L2，next = 3d × 0.5 = 1.5d
    const u = dim('item-a', 'understanding')!;
    expect(u.level).toBe(2);
    expect(u.nextReviewAt).toBe(new Date(T1.getTime() + 1.5 * DAY_MS).toISOString());

    const attempt = firstAttempt();
    expect(attempt.result).toBe('fail');
    expect(attempt.feedback).toBe('guessed');
    // post 快照同步更新
    const post = JSON.parse(attempt.postStateJson!) as {
      reviewStates: { understanding: { level: number } };
    };
    expect(post.reviewStates.understanding.level).toBe(2);
  });

  it('too_easy：以当前 post 状态 pass+tooEasy 重算 → 额外多升 1 级', async () => {
    await seedDueChoiceItem('item-a'); // L3
    await startSession();
    const a = taskByItem('item-a')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { recall: 'recalled' }); // → L4

    const res = submitTaskFeedback(db, deps, TZ, a.id, 'too_easy', T1);
    expect(res.adjustedResult).toBe('pass');
    // post L4 + pass(1) + tooEasy(1) → L6
    expect(dim('item-a', 'understanding')!.level).toBe(6);
    expect(firstAttempt().result).toBe('pass');
    expect(firstAttempt().feedback).toBe('too_easy');
  });

  it('too_easy 且查看过原句 → 结果上限 basic_pass', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const a = taskByItem('item-a')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, {
      selectedOptionId: 'o1',
      viewedSource: true,
    }); // basic_pass，L3 不变

    const res = submitTaskFeedback(db, deps, TZ, a.id, 'too_easy', T1);
    expect(res.adjustedResult).toBe('basic_pass');
    expect(dim('item-a', 'understanding')!.level).toBe(3); // 不得升级
  });

  it('重复反馈 → 409；learn 任务 → 409；未作答 → 409', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-c');
    await seedLearnItem('new-1');
    await startSession();
    const a = taskByItem('item-a')!;
    const c = taskByItem('item-c')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { selectedOptionId: 'o1' });
    await submitTaskFeedback(db, deps, TZ, a.id, 'guessed', T1);
    await expect(async () =>
      submitTaskFeedback(db, deps, TZ, a.id, 'too_easy', T2),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const learn = taskByItem('new-1', { type: 'learn' })!;
    await answerTodayTask(db, deps, TZ, NOW, learn.id, { selectedOptionId: 'o1' });
    await expect(async () =>
      submitTaskFeedback(db, deps, TZ, learn.id, 'too_easy', T1),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(async () =>
      submitTaskFeedback(db, deps, TZ, c.id, 'guessed', T2),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('会话已过期（非当日）→ 409', async () => {
    await seedDueChoiceItem('item-a');
    const yesterday = new Date(NOW.getTime() - DAY_MS);
    await startTodaySession(db, deps, TZ, yesterday);
    const a = tasks()[0]!;
    await answerTodayTask(db, deps, TZ, yesterday, a.id, { selectedOptionId: 'o1' });

    await expect(async () =>
      submitTaskFeedback(db, deps, TZ, a.id, 'guessed', NOW),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('过期') });
  });

  it('bad-question 后（void attempt）反馈 → 409', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const a = taskByItem('item-a')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { selectedOptionId: 'o1' });
    reportBadQuestion(db, a.id, T1);
    await expect(async () =>
      submitTaskFeedback(db, deps, TZ, a.id, 'guessed', T2),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
