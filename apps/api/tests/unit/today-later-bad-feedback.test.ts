import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  attempts,
  dailyStats,
  learningExamples,
  learningItems,
  questions,
  reviewSessions,
  reviewStates,
  reviewTasks,
} from '../../src/db/schema.js';
import {
  answerTodayTask,
  prepareTodayTask,
  deferTodayTask,
  reportBadQuestion,
  startTodaySession as startTodaySessionRaw,
  submitTaskFeedback,
  undoTodayTask,
  type TodayDeps,
} from '../../src/modules/today/service.js';
import { seedExample, seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';
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

async function seedDueChoiceItem(itemId: string, stability = 15): Promise<void> {
  await seedItem(db, { id: itemId, target: itemId, queueState: 'started' });
  await seedReviewState(db, itemId, 'understanding', {
    difficulty: 5,
    stability,
    reps: 3,
    lapses: 0,
    nextReviewAt: '2026-09-23T00:00:00.000Z',
    lastReviewAt: '2026-09-20T00:00:00.000Z',
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
    type: 'chunk',
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

    const res = deferTodayTask(db, a.id, TZ, NOW);
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
    deferTodayTask(db, a.id, TZ, NOW); // 未完成最大 sortKey=2 → 1002
    deferTodayTask(db, a.id, TZ, NOW); // 未完成最大 sortKey=1002 → 2002
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
    deferTodayTask(db, a.id, TZ, NOW);

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
    await expect(async () => deferTodayTask(db, a.id, TZ, NOW)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(async () => deferTodayTask(db, 'no-such', TZ, NOW)).rejects.toMatchObject({
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

    const res = reportBadQuestion(db, a.id, T1, TZ);
    expect(res.ok).toBe(true);
    expect(res.progress).toEqual({ completed: 0, total: 1 }); // 撤销后 a 不再计入

    // 两维快照回滚：U 精确恢复种子（S15/reps3/未复习）
    const u = dim('item-a', 'understanding')!;
    expect(u).toMatchObject({
      difficulty: 5,
      stability: 15,
      reps: 3,
      lapses: 0,
      nextReviewAt: '2026-09-23T00:00:00.000Z',
      lastReviewAt: '2026-09-20T00:00:00.000Z',
    });

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

    reportBadQuestion(db, learn.id, T1, TZ);

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

    reportBadQuestion(db, a.id, T1, TZ);

    const rfRow = tasks().find((t) => t.id === rf.id)!;
    expect(rfRow.canceledAt).toBe(T1.toISOString());
    // 状态回滚到 fail 前（精确恢复种子）
    expect(dim('item-a', 'understanding')!.lapses).toBe(0);
    expect(dim('item-a', 'understanding')!.nextReviewAt).toBe('2026-09-23T00:00:00.000Z');
  });

  it('后续已有同 item+维度作答 → 409 拒绝', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const a = taskByItem('item-a')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { selectedOptionId: 'o2' }); // fail → 补强
    const rf = tasks().find((t) => t.origin === 'reinforcement')!;
    await answerTodayTask(db, deps, TZ, T1, rf.id, { selectedOptionId: 'o1' }); // 后续作答

    await expect(async () => reportBadQuestion(db, a.id, T2, TZ)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('后续作答'),
    });
  });

  it('未作答任务不能标坏题 → 409；重复撤销幂等返回 ok', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const a = taskByItem('item-a')!;
    await expect(async () => reportBadQuestion(db, a.id, NOW, TZ)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    await answerTodayTask(db, deps, TZ, NOW, a.id, { selectedOptionId: 'o1' });
    const first = reportBadQuestion(db, a.id, T1, TZ);
    expect(first.ok).toBe(true);
    const second = reportBadQuestion(db, a.id, T2, TZ); // 幂等
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

    // 从 pre（S15）按 Again 重算：lapses+1、S 下降、间隔仍 ≥1 天
    const u = dim('item-a', 'understanding')!;
    expect(u.lapses).toBe(1);
    expect(u.stability!).toBeLessThan(15);
    expect(Date.parse(u.nextReviewAt!)).toBeGreaterThanOrEqual(T1.getTime() + DAY_MS);

    const attempt = firstAttempt();
    expect(attempt.result).toBe('fail');
    expect(attempt.feedback).toBe('guessed');
    // post 快照同步更新
    const post = JSON.parse(attempt.postStateJson!) as {
      reviewStates: { understanding: { lapses: number } };
    };
    expect(post.reviewStates.understanding.lapses).toBe(1);
  });

  it('too_easy：以当前 post 状态 pass+tooEasy 重算 → 额外多升 1 级', async () => {
    await seedDueChoiceItem('item-a'); // L3
    await startSession();
    const a = taskByItem('item-a')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { recall: 'recalled' }); // → L4

    const res = submitTaskFeedback(db, deps, TZ, a.id, 'too_easy', T1);
    expect(res.adjustedResult).toBe('pass');
    // post（Good 后）再 Easy 重算：reps 再 +1、S 进一步上升
    expect(dim('item-a', 'understanding')!.reps).toBe(5);
    expect(dim('item-a', 'understanding')!.stability!).toBeGreaterThan(15);
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
    expect(dim('item-a', 'understanding')!.correctStreak).toBe(0); // 结果上限 basic_pass：不记对
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
    reportBadQuestion(db, a.id, T1, TZ);
    await expect(async () =>
      submitTaskFeedback(db, deps, TZ, a.id, 'guessed', T2),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('undo（撤销最近一次作答）', () => {
  const T3 = new Date('2026-09-24T02:03:00.000Z');

  /** 带备用题的理解题种子（撤销替代题需要同 item 第二道不同 id 的题） */
  async function seedDueChoiceWithSpare(itemId: string, stability = 15): Promise<void> {
    await seedItem(db, { id: itemId, target: itemId, queueState: 'started' });
    await seedReviewState(db, itemId, 'understanding', {
      difficulty: 5,
      stability,
      reps: 3,
      lapses: 0,
      nextReviewAt: '2026-09-23T00:00:00.000Z',
      lastReviewAt: '2026-09-20T00:00:00.000Z',
    });
    for (const [idx, context] of [
      ['q1', 'A ____ sentence.'],
      ['q2', 'Another ____ sentence.'],
    ] as const) {
      await seedQuestion(db, itemId, {
        id: `${itemId}-${idx}`,
        type: 'understanding',
        payloadJson: choicePayload(DEFAULT_OPTIONS, '解释'),
        correctOptionId: 'o1',
        contextText: context,
      });
    }
  }

  function tasksByItem(itemId: string): Array<typeof reviewTasks.$inferSelect> {
    return db.select().from(reviewTasks).where(eq(reviewTasks.learningItemId, itemId)).all();
  }

  function attemptOfTask(taskId: string): typeof attempts.$inferSelect {
    return db.select().from(attempts).where(eq(attempts.reviewTaskId, taskId)).get()!;
  }

  function liveReplacementOf(itemId: string): typeof reviewTasks.$inferSelect {
    const live = tasksByItem(itemId).filter((t) => t.canceledAt === null);
    expect(live).toHaveLength(1);
    return live[0]!;
  }

  it('undo targets latest answer across tasks', async () => {
    await seedDueChoiceWithSpare('it-a');
    await seedDueChoiceWithSpare('it-b');
    await startSession();
    const a = taskByItem('it-a')!;
    const b = taskByItem('it-b')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { recall: 'recalled' }); // pass L3→L4
    await answerTodayTask(db, deps, TZ, T1, b.id, { recall: 'recalled' });

    // 撤销最近一次（b）：精确回滚 b，a 完好
    const res = await undoTodayTask(db, deps, TZ, T2, b.id);
    expect(res.ok).toBe(true);
    expect(res.progress).toEqual({ completed: 1, total: 2 });
    expect(dim('it-b', 'understanding')!.reps).toBe(3); // 精确回滚
    expect(dim('it-b', 'understanding')!.lastReviewAt).toBe('2026-09-20T00:00:00.000Z');
    expect(dim('it-a', 'understanding')!.reps).toBe(4); // 未受影响
    expect(attemptOfTask(b.id).result).toBe('void');
    expect(attemptOfTask(b.id).voidedAt).toBe(T2.toISOString());
    expect(attemptOfTask(a.id).result).toBe('pass');
    // 替代题：同 item/同题型/同维度/同 origin，但不同 question id，排在队列尾
    const replacement = liveReplacementOf('it-b');
    expect(replacement.id).not.toBe(b.id);
    expect(replacement.taskType).toBe(b.taskType);
    expect(replacement.dimension).toBe(b.dimension);
    expect(replacement.origin).toBe('base');
    expect(replacement.questionId).toBe('it-b-q2');
    expect(replacement.questionId).not.toBe(b.questionId);
    expect(replacement.completedAt).toBeNull();

    // 重复撤销同一任务：不得误伤更早的作答
    await expect(undoTodayTask(db, deps, TZ, T3, b.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(attemptOfTask(a.id).result).toBe('pass'); // 更早作答未被误 void

    // b 撤销后，最近一次有效作答是 a → 可继续撤销 a
    const resA = await undoTodayTask(db, deps, TZ, T3, a.id);
    expect(resA.ok).toBe(true);
    expect(dim('it-a', 'understanding')!.reps).toBe(3);
    expect(attemptOfTask(a.id).result).toBe('void');
  });

  it('stale task ID returns 409 without mutation', async () => {
    await seedDueChoiceWithSpare('it-a');
    await seedDueChoiceWithSpare('it-b');
    await startSession();
    const a = taskByItem('it-a')!;
    const b = taskByItem('it-b')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { recall: 'recalled' });
    await answerTodayTask(db, deps, TZ, T1, b.id, { recall: 'recalled' });

    // 另一台设备拿着旧任务 id 发起撤销 → 409
    await expect(undoTodayTask(db, deps, TZ, T2, a.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    // 无任何变更：a 的作答/状态/任务原样，未插替代题，也未消耗题目库存
    expect(attemptOfTask(a.id).result).toBe('pass');
    expect(attemptOfTask(a.id).voidedAt).toBeNull();
    expect(dim('it-a', 'understanding')!.reps).toBe(4);
    expect(taskByItem('it-a')!.canceledAt).toBeNull();
    expect(taskByItem('it-a')!.completedAt).not.toBeNull();
    expect(db.select().from(reviewTasks).all()).toHaveLength(2);
    expect(db.select().from(attempts).all()).toHaveLength(2);
    expect(db.select().from(questions).where(eq(questions.id, 'it-a-q2')).get()!.useCount).toBe(0);
  });

  it('parallel undo only settles once', async () => {
    await seedDueChoiceWithSpare('it-a');
    await startSession();
    const a = taskByItem('it-a')!;
    const res = await answerTodayTask(db, deps, TZ, NOW, a.id, { selectedOptionId: 'o2' }); // fail → 补强
    expect(res.reinforcementAdded).toBe(true);

    const settled = await Promise.allSettled([
      undoTodayTask(db, deps, TZ, T1, a.id),
      undoTodayTask(db, deps, TZ, T2, a.id),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);

    // 只结算一次：唯一替代题、唯一 void attempt、补强只取消一次、状态只回滚一次
    expect(
      tasksByItem('it-a').filter((t) => t.canceledAt === null && t.origin === 'base'),
    ).toHaveLength(1);
    expect(db.select().from(attempts).where(eq(attempts.result, 'void')).all()).toHaveLength(1);
    expect(
      tasks().filter((t) => t.origin === 'reinforcement' && t.canceledAt !== null),
    ).toHaveLength(1);
    expect(dim('it-a', 'understanding')!.reps).toBe(3); // 只回滚一次
    const stats = db.select().from(dailyStats).get()!;
    expect(stats.formalTasksCompleted).toBe(0);
  });

  it('answer cannot replay canceled task', async () => {
    await seedDueChoiceWithSpare('it-a');
    await startSession();
    const a = taskByItem('it-a')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { recall: 'recalled' });
    await undoTodayTask(db, deps, TZ, T1, a.id);

    // 被撤销任务不能再次作答（幂等回放也不行）
    await expect(
      answerTodayTask(db, deps, TZ, T2, a.id, { recall: 'recalled' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.select().from(attempts).where(eq(attempts.reviewTaskId, a.id)).all()).toHaveLength(1);
  });

  it('completed session reopens', async () => {
    await seedDueChoiceWithSpare('it-a');
    await startSession();
    const a = taskByItem('it-a')!;
    const res = await answerTodayTask(db, deps, TZ, NOW, a.id, { recall: 'recalled' });
    expect(res.completed).not.toBeNull(); // 唯一任务结算 → 会话完成
    expect(db.select().from(reviewSessions).get()!.completedAt).not.toBeNull();

    const undo = await undoTodayTask(db, deps, TZ, T1, a.id);
    expect(undo.ok).toBe(true);
    expect(db.select().from(reviewSessions).get()!.completedAt).toBeNull();
    expect(undo.progress).toEqual({ completed: 0, total: 1 });
  });

  it('different calendar day rejects undo', async () => {
    await seedDueChoiceWithSpare('it-a');
    await startTodaySession(db, deps, TZ, NOW); // 2026-09-24
    const a = taskByItem('it-a')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { recall: 'recalled' });

    const tomorrow = new Date(NOW.getTime() + DAY_MS);
    await expect(undoTodayTask(db, deps, TZ, tomorrow, a.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('今天'),
    });
    expect(attemptOfTask(a.id).voidedAt).toBeNull();
    expect(taskByItem('it-a')!.canceledAt).toBeNull();
  });
});

describe('undo（回滚覆盖）', () => {
  /** P 维度表达题种子（两道 production 题供替代） */
  async function seedProductionItemWithSpare(
    itemId: string,
    stability: number,
    opts: { understanding?: { stability: number } } = {},
  ): Promise<void> {
    await seedItem(db, { id: itemId, type: 'chunk', target: itemId, queueState: 'started' });
    await seedReviewState(db, itemId, 'production', {
      difficulty: 5,
      stability,
      reps: 4,
      lapses: 0,
      nextReviewAt: '2026-09-23T00:00:00.000Z',
      lastReviewAt: '2026-09-20T00:00:00.000Z',
    });
    if (opts.understanding) {
      await seedReviewState(db, itemId, 'understanding', {
        difficulty: 5,
        stability: opts.understanding.stability,
        reps: 8,
        nextReviewAt: '2026-10-01T00:00:00.000Z',
        lastReviewAt: '2026-09-20T00:00:00.000Z',
      });
    }
    for (const suffix of ['p1', 'p2'] as const) {
      await seedQuestion(db, itemId, {
        id: `${itemId}-${suffix}`,
        type: 'production',
        promptText: `请使用 ${itemId} 表达这个意思。`,
        payloadJson: JSON.stringify({
          mustUse: itemId,
          referenceAnswer: `They ${itemId} naturally.`,
          acceptanceNotes: '允许变化。',
        }),
        correctOptionId: null,
      });
    }
  }

  function attemptOfTask(taskId: string): typeof attempts.$inferSelect {
    return db.select().from(attempts).where(eq(attempts.reviewTaskId, taskId)).get()!;
  }

  function liveTasksOf(itemId: string): Array<typeof reviewTasks.$inferSelect> {
    return db
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.learningItemId, itemId), isNull(reviewTasks.canceledAt)))
      .all();
  }

  it('undo pass：U 维度回滚、daily_stats 回减、替代题同型不同 id、原题状态不变', async () => {
    await seedDueChoiceItem('ps-1');
    await seedQuestion(db, 'ps-1', {
      id: 'ps-1-q2',
      type: 'understanding',
      payloadJson: choicePayload(DEFAULT_OPTIONS),
      correctOptionId: 'o1',
    });
    await startSession();
    const t = taskByItem('ps-1')!;
    await answerTodayTask(db, deps, TZ, NOW, t.id, { recall: 'recalled' }); // Good：reps 3→4
    expect(dim('ps-1', 'understanding')!.reps).toBe(4);
    expect(db.select().from(dailyStats).get()!.formalTasksCompleted).toBe(1);

    const undo = await undoTodayTask(db, deps, TZ, T1, t.id);
    expect(undo.ok).toBe(true);

    const u = dim('ps-1', 'understanding')!;
    expect(u).toMatchObject({
      difficulty: 5,
      stability: 15,
      reps: 3,
      lapses: 0,
      nextReviewAt: '2026-09-23T00:00:00.000Z',
      lastReviewAt: '2026-09-20T00:00:00.000Z',
      correctStreak: 0,
    });
    expect(db.select().from(dailyStats).get()!.formalTasksCompleted).toBe(0);

    const replacement = liveTasksOf('ps-1')[0]!;
    expect(replacement.taskType).toBe('understanding');
    expect(replacement.dimension).toBe('understanding');
    expect(replacement.origin).toBe('base');
    expect(replacement.questionId).not.toBe(t.questionId);
    // 原题仍是 active（普通撤销不改题目状态，不进 bad_question）
    expect(db.select().from(questions).where(eq(questions.id, t.questionId!)).get()!.status).toBe(
      'active',
    );
  });

  it('undo basic_pass：level 不变、短间隔恢复为快照值', async () => {
    await seedDueChoiceItem('bp-1');
    await seedQuestion(db, 'bp-1', {
      id: 'bp-1-q2',
      type: 'understanding',
      payloadJson: choicePayload(DEFAULT_OPTIONS),
      correctOptionId: 'o1',
    });
    await startSession();
    const t = taskByItem('bp-1')!;
    await answerTodayTask(db, deps, TZ, NOW, t.id, { selectedOptionId: 'o1' }); // hint 语义 → basic_pass（Hard）
    expect(dim('bp-1', 'understanding')!.reps).toBe(4);
    expect(dim('bp-1', 'understanding')!.nextReviewAt).not.toBe('2026-09-23T00:00:00.000Z');

    await undoTodayTask(db, deps, TZ, T1, t.id);
    const u = dim('bp-1', 'understanding')!;
    expect(u.reps).toBe(3);
    expect(u.nextReviewAt).toBe('2026-09-23T00:00:00.000Z');
    expect(u.lastReviewAt).toBe('2026-09-20T00:00:00.000Z');
  });

  it('undo fail：取消本次插入的补强任务、降级回滚、stats 回减', async () => {
    await seedDueChoiceItem('fl-1');
    await seedQuestion(db, 'fl-1', {
      id: 'fl-1-q2',
      type: 'understanding',
      payloadJson: choicePayload(DEFAULT_OPTIONS),
      correctOptionId: 'o1',
    });
    await startSession();
    const t = taskByItem('fl-1')!;
    await answerTodayTask(db, deps, TZ, NOW, t.id, { selectedOptionId: 'o2' }); // fail → 补强
    expect(dim('fl-1', 'understanding')!.lapses).toBe(1);
    expect(dim('fl-1', 'understanding')!.wrongStreak).toBe(1);
    const rf = tasks().find((x) => x.origin === 'reinforcement')!;
    expect(rf.canceledAt).toBeNull();

    const undo = await undoTodayTask(db, deps, TZ, T1, t.id);
    expect(undo.ok).toBe(true);
    expect(undo.progress).toEqual({ completed: 0, total: 1 }); // 补强取消 + 原任务取消 + 替代插入

    const u = dim('fl-1', 'understanding')!;
    expect(u.lapses).toBe(0);
    expect(u.wrongStreak).toBe(0);
    expect(db.select().from(reviewTasks).where(eq(reviewTasks.id, rf.id)).get()!.canceledAt).toBe(
      T1.toISOString(),
    );
    expect(db.select().from(dailyStats).get()!.formalTasksCompleted).toBe(0);
  });

  it('undo Learn：删除两维状态、queue 回 new、额度与会话计数回滚、会话重新激活', async () => {
    await seedLearnItem('nw-1');
    await startSession();
    const learn = taskByItem('nw-1', { type: 'learn' })!;
    await answerTodayTask(db, deps, TZ, NOW, learn.id, { recall: 'recalled' });
    expect(db.select().from(reviewStates).all()).toHaveLength(2);
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'nw-1')).get()!.queueState,
    ).toBe('started');
    expect(db.select().from(dailyStats).get()).toMatchObject({
      formalTasksCompleted: 1,
      newItemsStarted: 1,
    });
    expect(db.select().from(reviewSessions).get()!.newItemsStarted).toBe(1);

    const undo = await undoTodayTask(db, deps, TZ, T1, learn.id);
    expect(undo.ok).toBe(true);

    expect(db.select().from(reviewStates).all()).toHaveLength(0); // 两维全部回滚
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'nw-1')).get()!.queueState,
    ).toBe('new');
    expect(db.select().from(dailyStats).get()).toMatchObject({
      formalTasksCompleted: 0,
      newItemsStarted: 0,
    });
    expect(db.select().from(reviewSessions).get()!.newItemsStarted).toBe(0);
    expect(db.select().from(reviewSessions).get()!.completedAt).toBeNull();
    const replacement = liveTasksOf('nw-1')[0]!;
    expect(replacement.taskType).toBe('learn');
    expect(replacement.dimension).toBe('understanding');
    expect(replacement.origin).toBe('base');
  });

  it('undo production pass：P 维度回滚、production_attempts/pass 回减、mastery 回滚', async () => {
    // U 已越过掌握线、P=S110 到期：pass 后 P 也越过掌握线 → item mastered
    await seedProductionItemWithSpare('pp-1', 118, { understanding: { stability: 130 } });
    await startSession();
    const t = liveTasksOf('pp-1').find((x) => x.taskType === 'production')!;
    await answerTodayTask(db, deps, TZ, NOW, t.id, { answerText: `I use pp-1 well.` });
    expect(db.select().from(learningItems).where(eq(learningItems.id, 'pp-1')).get()!.status).toBe(
      'mastered',
    );
    expect(dim('pp-1', 'production')!.stability!).toBeGreaterThanOrEqual(120);
    expect(db.select().from(dailyStats).get()).toMatchObject({
      formalTasksCompleted: 1,
      productionAttempts: 1,
      productionPass: 1,
    });

    const undo = await undoTodayTask(db, deps, TZ, T1, t.id);
    expect(undo.ok).toBe(true);

    expect(db.select().from(learningItems).where(eq(learningItems.id, 'pp-1')).get()!.status).toBe(
      'active',
    );
    const p = dim('pp-1', 'production')!;
    expect(p).toMatchObject({
      difficulty: 5,
      stability: 118,
      reps: 4,
      nextReviewAt: '2026-09-23T00:00:00.000Z',
      lastReviewAt: '2026-09-20T00:00:00.000Z',
    });
    // 另一维度不受影响（理解题状态保持快照原值）
    expect(dim('pp-1', 'understanding')!.stability).toBe(130);
    expect(db.select().from(dailyStats).get()).toMatchObject({
      formalTasksCompleted: 0,
      productionAttempts: 0,
      productionPass: 0,
    });
    const replacement = liveTasksOf('pp-1')[0]!;
    expect(replacement.taskType).toBe('production');
    expect(replacement.questionId).toBe('pp-1-p2');
  });

  it('undo production fail：降级与作答数回减、pass 数不变、无补强可取消', async () => {
    await seedProductionItemWithSpare('pf-1', 25);
    await startSession();
    const t = liveTasksOf('pf-1').find((x) => x.taskType === 'production')!;
    await answerTodayTask(db, deps, TZ, NOW, t.id, { answerText: 'nothing relevant' }); // fail
    expect(dim('pf-1', 'production')!.lapses).toBe(1);
    expect(
      db
        .select()
        .from(reviewTasks)
        .all()
        .filter((x) => x.origin === 'reinforcement'),
    ).toHaveLength(0);

    await undoTodayTask(db, deps, TZ, T1, t.id);
    expect(dim('pf-1', 'production')!.reps).toBe(4);
    expect(db.select().from(dailyStats).get()).toMatchObject({
      formalTasksCompleted: 0,
      productionAttempts: 0,
      productionPass: 0,
    });
    expect(liveTasksOf('pf-1')).toHaveLength(1);
  });

  it('undo production give-up：主动不会的作答同样可撤销', async () => {
    await seedProductionItemWithSpare('pg-1', 25);
    await startSession();
    const t = liveTasksOf('pg-1').find((x) => x.taskType === 'production')!;
    await answerTodayTask(db, deps, TZ, NOW, t.id, { giveUp: true });
    expect(attemptOfTask(t.id).feedback).toBe('gave_up');
    expect(dim('pg-1', 'production')!.lapses).toBe(1);

    const undo = await undoTodayTask(db, deps, TZ, T1, t.id);
    expect(undo.ok).toBe(true);
    expect(attemptOfTask(t.id).result).toBe('void');
    expect(attemptOfTask(t.id).feedback).toBeNull();
    expect(dim('pg-1', 'production')!.reps).toBe(4);
    expect(db.select().from(dailyStats).get()).toMatchObject({ productionAttempts: 0 });
  });

  it('undo Read 补强：旗标恢复、替代任务沿用 read_reinforcement、后续完成再清旗', async () => {
    await seedDueChoiceItem('rd-1');
    await seedQuestion(db, 'rd-1', {
      id: 'rd-1-q2',
      type: 'understanding',
      payloadJson: choicePayload(DEFAULT_OPTIONS),
      correctOptionId: 'o1',
    });
    await db
      .update(learningItems)
      .set({ needsReinforcement: 1 })
      .where(eq(learningItems.id, 'rd-1'))
      .run();
    await startSession();
    // 显式复原切换前已绑定的 Read 任务；V2 不再从 needsReinforcement 新排任务。
    const t = tasks().find((x) => x.learningItemId === 'rd-1')!;
    db.update(reviewTasks)
      .set({ origin: 'read_reinforcement' })
      .where(eq(reviewTasks.id, t.id))
      .run();
    await answerTodayTask(db, deps, TZ, NOW, t.id, { recall: 'recalled' });
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'rd-1')).get()!.needsReinforcement,
    ).toBe(0);

    const undo = await undoTodayTask(db, deps, TZ, T1, t.id);
    expect(undo.ok).toBe(true);
    // 旗标恢复为 1（read_reinforcement 语义保留：替代任务完成后再次清旗）
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'rd-1')).get()!.needsReinforcement,
    ).toBe(1);
    const replacement = tasks().find(
      (x) =>
        x.learningItemId === 'rd-1' && x.origin === 'read_reinforcement' && x.canceledAt === null,
    )!;
    expect(replacement.origin).toBe('read_reinforcement');

    await answerTodayTask(db, deps, TZ, T2, replacement.id, { recall: 'recalled' });
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'rd-1')).get()!.needsReinforcement,
    ).toBe(0);
  });

  it('undo 补强题：取消释放槽位、替代占用同一槽位不额外扣减配额', async () => {
    await seedDueChoiceItem('qt-1');
    await seedQuestion(db, 'qt-1', {
      id: 'qt-1-q2',
      type: 'understanding',
      payloadJson: choicePayload(DEFAULT_OPTIONS),
      correctOptionId: 'o1',
    });
    await startSession();
    const base = taskByItem('qt-1')!;
    await answerTodayTask(db, deps, TZ, NOW, base.id, { selectedOptionId: 'o2' }); // fail → rf1（1/2）
    const rf1 = tasks().find((x) => x.origin === 'reinforcement')!;
    await answerTodayTask(db, deps, TZ, T1, rf1.id, { selectedOptionId: 'o2' }); // 再 fail → rf2（2/2，配额用尽）
    const liveReinforcements = () =>
      tasks().filter((x) => x.origin === 'reinforcement' && x.canceledAt === null);
    expect(liveReinforcements()).toHaveLength(2);

    // 撤销最近一次作答（rf1 的 fail）：rf1 取消释放槽位；rf2 由 rf1 的 fail 产生，一并取消；
    // 替代题占用 rf1 释放的同一槽位 → 活跃补强数回到作答前的 1（不额外消耗配额）
    const undo = await undoTodayTask(db, deps, TZ, T2, rf1.id);
    expect(undo.ok).toBe(true);
    expect(liveReinforcements()).toHaveLength(1); // 仅替代题，不是 2/3
    const rf2 = tasks().find((x) => x.id !== rf1.id && x.origin === 'reinforcement')!;
    expect(rf2.canceledAt).not.toBeNull(); // 本次作答记录的补强被取消
    const replacement = liveReinforcements()[0]!;
    expect(replacement.origin).toBe('reinforcement');
    expect(replacement.dimension).toBe(rf1.dimension);
    expect(replacement.taskType).toBe(rf1.taskType);
    expect(replacement.questionId).not.toBe(rf1.questionId);
    // 替代补强位于队列尾
    const all = tasks();
    const maxSort = Math.max(...all.map((x) => x.sortKey));
    expect(replacement.sortKey).toBe(maxSort);

    // 槽位语义：撤销释放的槽位可用——替代题再 fail 仍可插 1 道补强（共 2 = 上限）
    await answerTodayTask(db, deps, TZ, new Date('2026-09-24T02:03:00.000Z'), replacement.id, {
      selectedOptionId: 'o2',
    });
    expect(liveReinforcements()).toHaveLength(2); // 替代 + 新插补强 = 上限 2
  });

  it('没有可用替代题：抛可重试错误且原作答、状态、会话完全不变', async () => {
    const depsNoGen = createFakeDeps({
      generateFailFor: new Set(['na-1:understanding']),
    });
    await seedDueChoiceItem('na-1'); // 仅 1 道题，且生成失败 → 无替代题
    await startTodaySession(db, depsNoGen, TZ, NOW);
    const t = taskByItem('na-1')!;
    await answerTodayTask(db, depsNoGen, TZ, NOW, t.id, { recall: 'recalled' });
    const statsBefore = db.select().from(dailyStats).get();

    await expect(undoTodayTask(db, depsNoGen, TZ, T1, t.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('重试'),
    });

    // 预取失败绝不启动回滚：作答/状态/任务/统计全部原样
    expect(attemptOfTask(t.id).result).toBe('pass');
    expect(attemptOfTask(t.id).voidedAt).toBeNull();
    expect(dim('na-1', 'understanding')!.reps).toBe(4);
    expect(taskByItem('na-1')!.canceledAt).toBeNull();
    expect(taskByItem('na-1')!.completedAt).not.toBeNull();
    expect(db.select().from(reviewTasks).all()).toHaveLength(1);
    expect(db.select().from(dailyStats).get()).toEqual(statsBefore);
  });
});

describe('undo（保留数据恢复）', () => {
  const DUE = '2026-09-23T00:00:00.000Z';

  /** 表达题种子（两道 production 题供替代），可预置个人例句 */
  async function seedProductionItemWithExamples(
    itemId: string,
    personal: Array<Partial<typeof learningExamples.$inferInsert>> = [],
  ): Promise<void> {
    await seedItem(db, { id: itemId, type: 'chunk', target: itemId, queueState: 'started' });
    await seedReviewState(db, itemId, 'production', {
      difficulty: 5,
      stability: 25,
      reps: 4,
      nextReviewAt: DUE,
      lastReviewAt: '2026-09-20T00:00:00.000Z',
    });
    for (const suffix of ['p1', 'p2'] as const) {
      await seedQuestion(db, itemId, {
        id: `${itemId}-${suffix}`,
        type: 'production',
        promptText: `请使用 ${itemId} 表达这个意思。`,
        payloadJson: JSON.stringify({
          mustUse: itemId,
          referenceAnswer: `They ${itemId} naturally.`,
          acceptanceNotes: '允许变化。',
        }),
        correctOptionId: null,
      });
    }
    for (const p of personal) {
      await seedExample(db, itemId, 'personal', p.text ?? 'personal sentence', {
        qualityScore: 0.5,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        ...p,
      });
    }
  }

  function attemptOfTask(taskId: string): typeof attempts.$inferSelect {
    return db.select().from(attempts).where(eq(attempts.reviewTaskId, taskId)).get()!;
  }

  function liveTasksOf(itemId: string): Array<typeof reviewTasks.$inferSelect> {
    return db
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.learningItemId, itemId), isNull(reviewTasks.canceledAt)))
      .all();
  }

  async function answerPass(itemId: string, when: Date): Promise<typeof reviewTasks.$inferSelect> {
    const started = await startTodaySession(db, deps, TZ, NOW);
    if (started.status !== 'active') throw new Error('start 失败');
    const t = liveTasksOf(itemId).find((x) => x.taskType === 'production')!;
    await answerTodayTask(db, deps, TZ, when, t.id, { answerText: `I use ${itemId} well.` });
    return t;
  }

  it('undo 恢复被替换的未固定个人例句（精确行）', async () => {
    await seedProductionItemWithExamples('ex-1', [
      { id: 'ex-worst', text: 'Old worst sentence.', qualityScore: 0.2 },
      { id: 'ex-mid', text: 'Mid sentence.', qualityScore: 0.6 },
      { id: 'ex-top', text: 'Top sentence.', qualityScore: 0.8, pinned: 1 },
    ]);
    const t = await answerPass('ex-1', NOW);
    // 沉淀时最差的未固定例句被替换删除
    expect(
      db.select().from(learningExamples).where(eq(learningExamples.id, 'ex-worst')).get(),
    ).toBeUndefined();
    const savedId = (
      JSON.parse(attemptOfTask(t.id).postStateJson!) as { personalExampleId: string }
    ).personalExampleId;
    expect(savedId).toBeTruthy();

    const undo = await undoTodayTask(db, deps, TZ, T1, t.id);
    expect(undo.ok).toBe(true);

    // 被替换例句按快照精确恢复（含 id/文本/分值/创建时间）
    const restored = db
      .select()
      .from(learningExamples)
      .where(eq(learningExamples.id, 'ex-worst'))
      .get()!;
    expect(restored).toMatchObject({
      id: 'ex-worst',
      learningItemId: 'ex-1',
      kind: 'personal',
      text: 'Old worst sentence.',
      qualityScore: 0.2,
      pinned: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    // 本次新增例句删除，其余原样
    expect(
      db.select().from(learningExamples).where(eq(learningExamples.id, savedId)).get(),
    ).toBeUndefined();
    const personal = db
      .select()
      .from(learningExamples)
      .where(
        and(eq(learningExamples.learningItemId, 'ex-1'), eq(learningExamples.kind, 'personal')),
      )
      .all();
    expect(personal.map((e) => e.id).sort()).toEqual(['ex-mid', 'ex-top', 'ex-worst'].sort());
    // post 快照记录了被替换行（DATABASE §8：撤销期间保留恢复快照）
    const post = JSON.parse(attemptOfTask(t.id).postStateJson!) as {
      replacedPersonalExample?: { id: string };
    };
    expect(post.replacedPersonalExample?.id).toBe('ex-worst');
  });

  it('undo 删除本次新增的个人例句', async () => {
    await seedProductionItemWithExamples('ex-2'); // 无既有 personal → 新增而非替换
    const t = await answerPass('ex-2', NOW);
    const savedId = (
      JSON.parse(attemptOfTask(t.id).postStateJson!) as { personalExampleId: string }
    ).personalExampleId;
    expect(savedId).toBeTruthy();

    const undo = await undoTodayTask(db, deps, TZ, T1, t.id);
    expect(undo.ok).toBe(true);
    expect(
      db.select().from(learningExamples).where(eq(learningExamples.id, savedId)).get(),
    ).toBeUndefined();
    expect(
      db
        .select()
        .from(learningExamples)
        .where(
          and(eq(learningExamples.learningItemId, 'ex-2'), eq(learningExamples.kind, 'personal')),
        )
        .all(),
    ).toHaveLength(0);
  });

  it('新例句已被固定 → 409 且不破坏用户数据', async () => {
    await seedProductionItemWithExamples('pn-1');
    const t = await answerPass('pn-1', NOW);
    const savedId = (
      JSON.parse(attemptOfTask(t.id).postStateJson!) as { personalExampleId: string }
    ).personalExampleId!;
    db.update(learningExamples).set({ pinned: 1 }).where(eq(learningExamples.id, savedId)).run();

    await expect(undoTodayTask(db, deps, TZ, T1, t.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    // 无任何变更：例句保留（含固定标记）、attempt 未作废、任务未取消
    const saved = db.select().from(learningExamples).where(eq(learningExamples.id, savedId)).get()!;
    expect(saved.pinned).toBe(1);
    expect(attemptOfTask(t.id).voidedAt).toBeNull();
    expect(taskByItem('pn-1')!.canceledAt).toBeNull();
    expect(db.select().from(reviewTasks).all()).toHaveLength(1);
  });

  it('新例句已被编辑 → 409', async () => {
    await seedProductionItemWithExamples('ed-1');
    const t = await answerPass('ed-1', NOW);
    const savedId = (
      JSON.parse(attemptOfTask(t.id).postStateJson!) as { personalExampleId: string }
    ).personalExampleId!;
    db.update(learningExamples)
      .set({ text: 'User edited this sentence.' })
      .where(eq(learningExamples.id, savedId))
      .run();

    await expect(undoTodayTask(db, deps, TZ, T1, t.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      db.select().from(learningExamples).where(eq(learningExamples.id, savedId)).get()!.text,
    ).toBe('User edited this sentence.');
    expect(attemptOfTask(t.id).voidedAt).toBeNull();
  });

  it('10 条边界：撤销恢复被裁剪的表达历史行（精确恢复）', async () => {
    const itemId = 'hm-1';
    await seedProductionItemWithExamples(itemId);
    // 预置 10 条历史 production attempts（占满保留上限）
    for (let i = 0; i < 10; i++) {
      db.insert(attempts)
        .values({
          id: `old-${i}`,
          reviewTaskId: null,
          learningItemId: itemId,
          questionId: `${itemId}-p1`,
          mode: 'today',
          answerText: `Old ${i}`,
          selectedOptionId: null,
          result: 'pass',
          viewedSource: 0,
          feedback: null,
          outcomeSource: null,
          correctionJson: null,
          explanation: null,
          betterVersion: null,
          aiPromptKey: null,
          aiPromptVersion: null,
          aiPromptHash: null,
          aiModel: null,
          preStateJson: null,
          postStateJson: null,
          createdAt: new Date(Date.parse(DUE) + i * 60_000).toISOString(),
          voidedAt: null,
        })
        .run();
    }
    const t = await answerPass(itemId, NOW);
    // 第 11 条插入后最旧的被裁剪
    const rowsAfter = db.select().from(attempts).where(eq(attempts.learningItemId, itemId)).all();
    expect(rowsAfter).toHaveLength(10);
    expect(rowsAfter.map((r) => r.id)).not.toContain('old-0');
    // 被裁剪行序列化进本次 attempt 的 post 快照
    const post = JSON.parse(attemptOfTask(t.id).postStateJson!) as {
      prunedProductionAttempts?: Array<{ id: string }>;
    };
    expect(post.prunedProductionAttempts?.map((r) => r.id)).toEqual(['old-0']);

    const undo = await undoTodayTask(db, deps, TZ, T1, t.id);
    expect(undo.ok).toBe(true);
    const restored = db.select().from(attempts).where(eq(attempts.id, 'old-0')).get()!;
    expect(restored.answerText).toBe('Old 0');
    expect(restored.result).toBe('pass');
    expect(restored.createdAt).toBe(new Date(Date.parse(DUE)).toISOString());
  });
});
