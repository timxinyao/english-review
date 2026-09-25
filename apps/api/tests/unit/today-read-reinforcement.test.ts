import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  attempts,
  dailyStats,
  learningItems,
  reviewSessions,
  reviewTasks,
} from '../../src/db/schema.js';
import {
  answerTodayTask,
  reportBadQuestion,
  startTodaySession,
  type TodayDeps,
} from '../../src/modules/today/service.js';
import { seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';
import { choicePayload, createFakeDeps, DEFAULT_OPTIONS } from '../helpers/today-fakes.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-09-24T02:00:00.000Z'); // 上海 2026-09-24 10:00
const LATER = new Date('2026-09-24T04:00:00.000Z');
const YESTERDAY_ISO = '2026-09-23T00:00:00.000Z';
const TODAY = '2026-09-24';

let db: AppDatabase;
let deps: TodayDeps;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
  deps = createFakeDeps();
});

/** active+started + U 维到期 + n 道 understanding 题 */
async function seedStartedItem(
  itemId: string,
  opts: { flagged?: boolean; questions?: number; due?: boolean } = {},
): Promise<void> {
  await seedItem(db, {
    id: itemId,
    target: itemId,
    queueState: 'started',
    needsReinforcement: opts.flagged ? 1 : 0,
  });
  await seedReviewState(db, itemId, 'understanding', {
    level: 3,
    nextReviewAt: opts.due === false ? '2026-10-01T00:00:00.000Z' : YESTERDAY_ISO,
  });
  for (let i = 0; i < (opts.questions ?? 1); i++) {
    await seedQuestion(db, itemId, {
      type: 'understanding',
      payloadJson: choicePayload(DEFAULT_OPTIONS),
      correctOptionId: 'o1',
      contextText: `A ____ sentence (${i}).`,
    });
  }
}

function tasksOf(sessionId: string) {
  return db.select().from(reviewTasks).where(eq(reviewTasks.sessionId, sessionId)).all();
}

describe('today start：read_reinforcement 接入', () => {
  it('置旗项生成 origin=read_reinforcement 的理解任务，计入 base_task_count 与混排', async () => {
    await seedStartedItem('flag-a', { flagged: true });
    await seedStartedItem('plain-b');

    const res = await startTodaySession(db, deps, TZ, NOW);
    expect(res.status).toBe('active');
    const session = db
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.sessionDate, TODAY))
      .get()!;
    // flag-a 到期 base + flag-a read_reinforcement + plain-b base
    expect(session.baseTaskCount).toBe(3);

    const readTasks = tasksOf(session.id).filter((t) => t.origin === 'read_reinforcement');
    expect(readTasks).toHaveLength(1);
    expect(readTasks[0]).toMatchObject({
      learningItemId: 'flag-a',
      dimension: 'understanding',
      taskType: 'understanding',
      questionId: expect.any(String),
    });
    expect(tasksOf(session.id).filter((t) => t.origin === 'base')).toHaveLength(2);
  });

  it('无题且 AI 生成失败 → 跳过该项（log），其余任务照常', async () => {
    deps = createFakeDeps({ generateFailFor: new Set(['flag-x:understanding']) });
    await seedStartedItem('flag-x', { flagged: true, questions: 0 });
    await seedStartedItem('plain-b');

    const res = await startTodaySession(db, deps, TZ, NOW);
    expect(res.status).toBe('active');
    const session = db
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.sessionDate, TODAY))
      .get()!;
    const all = tasksOf(session.id);
    expect(all).toHaveLength(1); // 只剩 plain-b 的 base 任务
    expect(all.every((t) => t.origin === 'base')).toBe(true);
  });

  it('同一 item 同 session 只生成 1 个 read_reinforcement（与 base 任务并存且题目不同）', async () => {
    // 置旗且到期：base 任务 + read_reinforcement 任务，两题必须不同
    await seedStartedItem('flag-due', { flagged: true, questions: 2 });

    await startTodaySession(db, deps, TZ, NOW);
    const session = db
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.sessionDate, TODAY))
      .get()!;
    const all = tasksOf(session.id);
    expect(all).toHaveLength(2);
    const readTask = all.find((t) => t.origin === 'read_reinforcement')!;
    const baseTask = all.find((t) => t.origin === 'base')!;
    expect(readTask.learningItemId).toBe('flag-due');
    expect(readTask.questionId).not.toBe(baseTask.questionId);
  });

  it('paused / archived / 非 active 项不生成 read_reinforcement', async () => {
    await seedStartedItem('paused-flag', { flagged: true });
    db.update(learningItems)
      .set({ status: 'paused' })
      .where(eq(learningItems.id, 'paused-flag'))
      .run();

    const res = await startTodaySession(db, deps, TZ, NOW);
    expect(res.status).toBe('completed'); // 无任何任务 → 空会话完成
    const session = db
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.sessionDate, TODAY))
      .get()!;
    expect(tasksOf(session.id)).toHaveLength(0);
  });
});

describe('today answer：read_reinforcement 完成', () => {
  async function startWithFlagged(
    opts: { questions?: number } = {},
  ): Promise<{ readTaskId: string }> {
    await seedStartedItem('flag-a', { flagged: true, questions: opts.questions ?? 2 });
    await startTodaySession(db, deps, TZ, NOW);
    const session = db
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.sessionDate, TODAY))
      .get()!;
    const readTask = tasksOf(session.id).find((t) => t.origin === 'read_reinforcement')!;
    expect(readTask).toBeTruthy();
    return { readTaskId: readTask.id };
  }

  it('答错也清旗；计入 daily_stats 正式任务；fail 另插 origin=reinforcement 补强', async () => {
    const { readTaskId } = await startWithFlagged();

    const res = await answerTodayTask(db, deps, TZ, LATER, readTaskId, { selectedOptionId: 'o2' });
    expect(res.result).toBe('fail');
    expect(res.alreadyCompleted).toBeUndefined(); // 首答不携带该字段（仅幂等回放返回）

    const item = db.select().from(learningItems).where(eq(learningItems.id, 'flag-a')).get()!;
    expect(item.needsReinforcement).toBe(0); // 无论对错都清旗

    const stats = db.select().from(dailyStats).where(eq(dailyStats.date, TODAY)).get()!;
    expect(stats.formalTasksCompleted).toBe(1);

    const session = db
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.sessionDate, TODAY))
      .get()!;
    const reinforce = tasksOf(session.id).filter((t) => t.origin === 'reinforcement');
    expect(reinforce).toHaveLength(1); // 普通 fail 补强照常
  });

  it('答对清旗', async () => {
    const { readTaskId } = await startWithFlagged();
    await answerTodayTask(db, deps, TZ, LATER, readTaskId, { selectedOptionId: 'o1' });
    const item = db.select().from(learningItems).where(eq(learningItems.id, 'flag-a')).get()!;
    expect(item.needsReinforcement).toBe(0);
  });

  it('bad-question 撤销该任务 → 旗回滚为 1，stats 回减', async () => {
    const { readTaskId } = await startWithFlagged();
    await answerTodayTask(db, deps, TZ, LATER, readTaskId, { selectedOptionId: 'o2' });
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'flag-a')).get()!
        .needsReinforcement,
    ).toBe(0);

    reportBadQuestion(db, readTaskId, new Date('2026-09-24T05:00:00.000Z'));
    const item = db.select().from(learningItems).where(eq(learningItems.id, 'flag-a')).get()!;
    expect(item.needsReinforcement).toBe(1); // 回滚

    const stats = db.select().from(dailyStats).where(eq(dailyStats.date, TODAY)).get();
    expect(stats?.formalTasksCompleted ?? 0).toBe(0);
  });

  it('普通 base 任务完成不清旗（旗只由 read_reinforcement 清）', async () => {
    await seedStartedItem('flag-idle', { flagged: true, due: false, questions: 1 });
    await seedStartedItem('plain-b');
    await startTodaySession(db, deps, TZ, NOW);
    const session = db
      .select()
      .from(reviewSessions)
      .where(eq(reviewSessions.sessionDate, TODAY))
      .get()!;
    const baseTask = tasksOf(session.id).find((t) => t.origin === 'base')!;

    await answerTodayTask(db, deps, TZ, LATER, baseTask.id, { selectedOptionId: 'o1' });
    const item = db.select().from(learningItems).where(eq(learningItems.id, 'flag-idle')).get()!;
    expect(item.needsReinforcement).toBe(1); // 旗保持
  });

  it('read_reinforcement 任务的 pre/post 快照包含 needsReinforcement（撤销依据）', async () => {
    const { readTaskId } = await startWithFlagged();
    await answerTodayTask(db, deps, TZ, LATER, readTaskId, { selectedOptionId: 'o1' });
    const attempt = db.select().from(attempts).where(eq(attempts.reviewTaskId, readTaskId)).get()!;
    expect(attempt).toBeTruthy();
    const pre = JSON.parse(attempt.preStateJson!) as { needsReinforcement?: number };
    const post = JSON.parse(attempt.postStateJson!) as { needsReinforcement?: number };
    expect(pre.needsReinforcement).toBe(1);
    expect(post.needsReinforcement).toBe(0);
  });
});
