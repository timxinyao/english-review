import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
  startTodaySession as startTodaySessionRaw,
  type TodayDeps,
} from '../../src/modules/today/service.js';
import {
  seedExample,
  seedItem,
  seedLegacyBoundTask,
  seedQuestion,
  seedReviewState,
} from '../helpers/seed.js';
import { choicePayload, createFakeDeps, DEFAULT_OPTIONS } from '../helpers/today-fakes.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-09-24T02:00:00.000Z');
const DAY_MS = 24 * 3600 * 1000;
const iso = (d: Date) => d.toISOString();

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
        task.canceledAt === null &&
        task.questionId === null
      ) {
        await prepareTodayTask(testDb, testDeps, timezone, now, task.id);
      }
    }
  }
  return result;
}

async function seedDueChoiceItem(
  itemId: string,
  level = 3,
  explanation = '解释文本',
): Promise<string> {
  await seedItem(db, { id: itemId, target: itemId, queueState: 'started' });
  await seedReviewState(db, itemId, 'understanding', {
    level,
    nextReviewAt: '2026-09-23T00:00:00.000Z',
  });
  await seedQuestion(db, itemId, {
    type: 'understanding',
    payloadJson: choicePayload(DEFAULT_OPTIONS, explanation),
    correctOptionId: 'o1',
    contextText: 'A ____ sentence.',
    promptText: `${itemId} 在这里最接近什么意思？`,
  });
  return itemId;
}

async function seedDueClozeItem(itemId: string, accepted: string[]): Promise<string> {
  await seedItem(db, { id: itemId, target: itemId, queueState: 'started' });
  await seedReviewState(db, itemId, 'production', {
    level: 1,
    nextReviewAt: '2026-09-23T00:00:00.000Z',
  });
  const questionId = await seedQuestion(db, itemId, {
    type: 'cloze',
    payloadJson: JSON.stringify({ acceptedAnswers: accepted, explanation: 'cloze 解释' }),
    correctOptionId: null,
    contextText: `We need the ____ ${itemId} before processing.`,
  });
  seedLegacyBoundTask(db, itemId, questionId, NOW, TZ);
  return itemId;
}

async function seedDueProductionItem(itemId: string, mustUse: string): Promise<string> {
  await seedItem(db, { id: itemId, type: 'chunk', target: mustUse, queueState: 'started' });
  await seedReviewState(db, itemId, 'production', {
    level: 4,
    nextReviewAt: '2026-09-23T00:00:00.000Z',
  });
  await seedQuestion(db, itemId, {
    id: `${itemId}-prod`,
    type: 'production',
    promptText: `请使用 ${mustUse} 表达这个意思。`,
    payloadJson: JSON.stringify({
      mustUse,
      referenceAnswer: `They ${mustUse} naturally.`,
      acceptanceNotes: '允许正常时态变化。',
    }),
    correctOptionId: null,
  });
  return itemId;
}

async function seedLearnItem(itemId: string, withExample = true): Promise<void> {
  await seedItem(db, {
    id: itemId,
    type: 'chunk',
    target: itemId,
    queueState: 'new',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  if (withExample) {
    await seedExample(db, itemId, 'source', `Source of ${itemId}.`);
    await seedExample(db, itemId, 'extra', `Extra of ${itemId}.`);
  }
  await seedQuestion(db, itemId, {
    type: 'understanding',
    payloadJson: choicePayload(DEFAULT_OPTIONS),
    correctOptionId: 'o1',
    contextText: '____ fills the blank.',
    promptText: `${itemId} 最接近什么意思？`,
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
  const found = tasks().filter(
    (t) =>
      t.learningItemId === itemId &&
      (opts.type === undefined || t.taskType === opts.type) &&
      (opts.origin === undefined || t.origin === opts.origin) &&
      (!opts.pending || (t.completedAt === null && t.canceledAt === null)),
  );
  return found[0] ?? null;
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

function stats(): typeof dailyStats.$inferSelect | null {
  return db.select().from(dailyStats).get() ?? null;
}

describe('answer：理解题（understanding 复习）', () => {
  it('recall=recalled 答对 → pass：状态升级、attempt 快照、任务结算、daily_stats 计数', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, { recall: 'recalled' });
    expect(res.result).toBe('pass');
    expect(res.outcomeSource).toBe('recalled');
    expect(res.correct).toBe(true);
    expect(res.alreadyCompleted).toBeUndefined();
    expect(res.explanation).toBeNull(); // 答对不揭示解释
    expect(res.correctOptionId).toBe('o1');
    expect(res.reinforcementAdded).toBe(false);
    expect(res.progress).toEqual({ completed: 1, total: 1 });
    // 唯一任务结算后会话完成并返回摘要
    expect(res.completed).toEqual({
      totalTasks: 1,
      pass: 1,
      basicPass: 0,
      fail: 0,
      newItemsStarted: 0,
      recommendRead: false,
    });

    // 状态推进：L3 → L4，next = 14 天后
    const u = dim('item-a', 'understanding')!;
    expect(u.level).toBe(4);
    expect(u.stable).toBe(0);
    expect(u.nextReviewAt).toBe(iso(new Date(NOW.getTime() + 14 * DAY_MS)));

    // 任务与统计
    expect(tasks()[0]!.completedAt).toBe(iso(NOW));
    expect(stats()).toMatchObject({ formalTasksCompleted: 1, newItemsStarted: 0 });

    // attempt：pre/post 快照 + result
    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.result).toBe('pass');
    expect(attempt.outcomeSource).toBe('recalled');
    expect(attempt.selectedOptionId).toBeNull();
    expect(attempt.mode).toBe('today');
    const pre = JSON.parse(attempt.preStateJson!) as {
      reviewStates: { understanding: { level: number } };
    };
    const post = JSON.parse(attempt.postStateJson!) as {
      reviewStates: { understanding: { level: number } };
      itemStatus: string;
      reinforcementTaskIds: string[];
    };
    expect(pre.reviewStates.understanding.level).toBe(3);
    expect(post.reviewStates.understanding.level).toBe(4);
    expect(post.itemStatus).toBe('active');
    expect(post.reinforcementTaskIds).toEqual([]);
  });

  it('hint 选错 → fail：降级、揭示正确项与解释、插入补强任务', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await seedDueChoiceItem('item-c');
    await seedDueChoiceItem('item-d');
    await startSession();
    const task = taskByItem('item-a')!; // sortKey 1

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, {
      selectedOptionId: 'o2',
      hintUsed: true,
    });
    expect(res.result).toBe('fail');
    expect(res.outcomeSource).toBe('forgot');
    expect(res.correct).toBe(false);
    expect(res.explanation).toBe('解释文本');
    expect(res.correctOptionId).toBe('o1');
    expect(res.reinforcementAdded).toBe(true);
    expect(res.progress).toEqual({ completed: 1, total: 5 }); // 4 base + 1 补强

    // 状态降级：L3 → L2，next = 降级间隔 3d × 0.5 = 1.5 天
    const u = dim('item-a', 'understanding')!;
    expect(u.level).toBe(2);
    expect(u.nextReviewAt).toBe(iso(new Date(NOW.getTime() + 1.5 * DAY_MS)));

    // 补强任务：同 item 同维度，origin=reinforcement
    const rf = tasks().find((t) => t.origin === 'reinforcement')!;
    expect(rf.learningItemId).toBe('item-a');
    expect(rf.dimension).toBe('understanding');
    expect(rf.taskType).toBe('understanding');
    expect(rf.completedAt).toBeNull();
    // 位置：max(sortKey1+3, 剩余队列后 30% 边界(第 4 题 sortKey=4)) + 0.5
    expect(rf.sortKey).toBe(4.5);

    // post 快照记录补强任务 id
    const attempt = db.select().from(attempts).all()[0]!;
    const post = JSON.parse(attempt.postStateJson!) as { reinforcementTaskIds: string[] };
    expect(post.reinforcementTaskIds).toEqual([rf.id]);
  });

  it('hint 选对 → basic_pass：不升级、半间隔（viewedSource 不再影响档位）', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, {
      selectedOptionId: 'o1',
      hintUsed: true,
      viewedSource: true,
    });
    expect(res.result).toBe('basic_pass');
    expect(res.outcomeSource).toBe('assisted');
    expect(res.correct).toBe(true);
    const u = dim('item-a', 'understanding')!;
    expect(u.level).toBe(3); // 不升级
    expect(u.nextReviewAt).toBe(iso(new Date(NOW.getTime() + 3.5 * DAY_MS))); // L3 间隔 7d × 0.5 = 3.5d
    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.viewedSource).toBe(1);
    expect(attempt.result).toBe('basic_pass');
    expect(attempt.outcomeSource).toBe('assisted');
  });

  it('Recall 题必须提交 recall 或 selectedOptionId，否则 400', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const task = taskByItem('item-a')!;
    await expect(
      answerTodayTask(db, deps, TZ, NOW, task.id, { viewedSource: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('任务不存在 → 404', async () => {
    await expect(
      answerTodayTask(db, deps, TZ, NOW, 'no-such-task', { selectedOptionId: 'o1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('answer：填空题（cloze）', () => {
  it('答对（含空白/大小写归一）→ pass，揭示完整句子与可接受答案', async () => {
    await seedDueClozeItem('item-a', ['raw']);
    await startSession();
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, { answerText: ' Raw ' });
    expect(res.result).toBe('pass');
    expect(res.completeSentence).toBe('We need the raw item-a before processing.');
    expect(res.acceptedAnswer).toBe('raw');
    expect(res.correctOptionId).toBeNull();

    const p = dim('item-a', 'production')!;
    expect(p.level).toBe(2); // L1 → L2
  });

  it('答错 → fail，揭示解释并插入 cloze 补强（不复用刚答错的题）', async () => {
    await seedItem(db, { id: 'item-a', target: 'item-a', queueState: 'started' });
    await seedReviewState(db, 'item-a', 'production', {
      level: 1,
      nextReviewAt: '2026-09-23T00:00:00.000Z',
    });
    const questionId = await seedQuestion(db, 'item-a', {
      type: 'cloze',
      payloadJson: JSON.stringify({ acceptedAnswers: ['raw'], explanation: 'cloze 解释' }),
      contextText: 'We need the ____ item-a before processing.',
      createdAt: '2026-09-10T00:00:00.000Z',
    });
    await seedQuestion(db, 'item-a', {
      type: 'cloze',
      payloadJson: JSON.stringify({ acceptedAnswers: ['raw2'] }),
      contextText: 'Another ____ here.',
      createdAt: '2026-09-20T00:00:00.000Z',
    });
    seedLegacyBoundTask(db, 'item-a', questionId, NOW, TZ);
    await startSession();
    const task = taskByItem('item-a')!;
    expect(task.questionId).not.toBeNull();

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, { answerText: 'cooked' });
    expect(res.result).toBe('fail');
    expect(res.explanation).toBe('cloze 解释');
    expect(res.completeSentence).toBe('We need the raw item-a before processing.');
    expect(res.acceptedAnswer).toBe('raw');
    expect(res.reinforcementAdded).toBe(true);

    const rf = tasks().find((t) => t.origin === 'reinforcement')!;
    expect(rf.taskType).toBe('cloze');
    expect(rf.questionId).not.toBe(task.questionId); // 不复用刚答错的题
  });

  it('填空题必须提交 answerText，否则 400', async () => {
    await seedDueClozeItem('item-a', ['raw']);
    await startSession();
    const task = taskByItem('item-a')!;
    await expect(
      answerTodayTask(db, deps, TZ, NOW, task.id, { selectedOptionId: 'o1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('answer：Learn 任务', () => {
  it.each([
    ['word', null, false],
    ['word', 1, true],
    ['chunk', null, true],
    ['chunk', 0, false],
  ] as const)('Learn %s override=%s 仅有效目标开启时激活 P', async (type, override, enabled) => {
    await seedLearnItem('goal');
    db.update(learningItems)
      .set({ type, productionEnabledOverride: override })
      .where(eq(learningItems.id, 'goal'))
      .run();
    await seedReviewState(db, 'goal', 'production');
    await startSession();
    await answerTodayTask(db, deps, TZ, NOW, taskByItem('goal')!.id, { recall: 'forgot' });
    expect(dim('goal', 'understanding')!.level).toBe(1);
    expect(dim('goal', 'production')).toMatchObject({
      level: 0,
      nextReviewAt: enabled ? '2026-09-25T02:00:00.000Z' : null,
    });
    expect(stats()?.newItemsStarted).toBe(1);
  });
  it('答对（recall=recalled）→ 激活 U/P 两维初始状态、queue_state=started、额度+1', async () => {
    await seedLearnItem('new-1');
    await startSession();
    const learn = taskByItem('new-1', { type: 'learn' })!;

    const res = await answerTodayTask(db, deps, TZ, NOW, learn.id, { recall: 'recalled' });
    expect(res.result).toBe('pass');
    expect(res.outcomeSource).toBe('recalled');

    const u = dim('new-1', 'understanding')!;
    const p = dim('new-1', 'production')!;
    expect(u.level).toBe(1);
    expect(u.nextReviewAt).toBe(iso(new Date(NOW.getTime() + DAY_MS)));
    expect(u.lastReviewAt).toBe(iso(NOW));
    // Production 激活但未首答：L0、next=+1d、lastReviewAt=null（review 契约）
    expect(p.level).toBe(0);
    expect(p.nextReviewAt).toBe(iso(new Date(NOW.getTime() + DAY_MS)));
    expect(p.lastReviewAt).toBeNull();

    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'new-1')).get()?.queueState,
    ).toBe('started');
    expect(stats()).toMatchObject({ formalTasksCompleted: 1, newItemsStarted: 1 });
    const session = db.select().from(reviewSessions).get()!;
    expect(session.newItemsStarted).toBe(1);
  });

  it('答错（forgot）→ 同样初始化 U/P 两维、queue_state=started、额度+1、不插补强（揭示即教学）', async () => {
    await seedLearnItem('new-1');
    await startSession();
    const learn = taskByItem('new-1', { type: 'learn' })!;

    const res = await answerTodayTask(db, deps, TZ, NOW, learn.id, { recall: 'forgot' });
    expect(res.result).toBe('fail');
    expect(res.outcomeSource).toBe('forgot');

    // 方案 A：三路径都完成新学 → U/P 两维行均初始化
    expect(db.select().from(reviewStates).all()).toHaveLength(2);
    expect(dim('new-1', 'understanding')!.level).toBe(1);
    expect(dim('new-1', 'production')!.level).toBe(0);
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'new-1')).get()?.queueState,
    ).toBe('started');
    expect(stats()).toMatchObject({ formalTasksCompleted: 1, newItemsStarted: 1 });
    const session = db.select().from(reviewSessions).get()!;
    expect(session.newItemsStarted).toBe(1);

    // learn fail 不再插入同会话补强（reveal 已教学）
    expect(res.reinforcementAdded).toBe(false);
    expect(tasks().filter((t) => t.origin === 'reinforcement')).toHaveLength(0);
  });
});

describe('answer：幂等', () => {
  it.each([false, true])('题目在批改%s时失效，拒绝结算且不写学习记录', async (duringEvaluation) => {
    await seedDueProductionItem('edited', 'wear down');
    await startSession();
    const task = taskByItem('edited')!;
    const retire = () =>
      db
        .update(questions)
        .set({ status: 'retired' })
        .where(eq(questions.id, task.questionId!))
        .run();
    const original = deps.evaluateProduction;
    if (duringEvaluation)
      deps.evaluateProduction = async (...args) => {
        retire();
        return original(...args);
      };
    else retire();
    await expect(
      answerTodayTask(db, deps, TZ, NOW, task.id, {
        answerText: 'Stress will wear down everyone.',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.select().from(attempts).all()).toEqual([]);
    expect(stats()).toBeNull();
    expect(dim('edited', 'production')!.level).toBe(4);
  });
  it('批改期间跨本地日，事务再次拒绝且不产生学习写入', async () => {
    await seedDueProductionItem('midnight', 'wear down');
    await startSession();
    const nextDay = new Date('2026-09-24T16:00:00.000Z');
    await expect(
      answerTodayTask(
        db,
        deps,
        TZ,
        NOW,
        taskByItem('midnight')!.id,
        { answerText: 'Stress will wear down everyone.' },
        () => nextDay,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.select().from(attempts).all()).toEqual([]);
    expect(stats()).toBeNull();
    expect(dim('midnight', 'production')!.level).toBe(4);
  });
  it('跨本地日 answer 和已完成 replay 均拒绝，学习状态和统计不变', async () => {
    await seedDueChoiceItem('expired');
    await seedDueChoiceItem('answered');
    await startSession();
    const answered = taskByItem('answered')!;
    await answerTodayTask(db, deps, TZ, NOW, answered.id, { recall: 'recalled' });
    const before = {
      attempts: db.select().from(attempts).all(),
      stats: stats(),
      states: db.select().from(reviewStates).all(),
    };
    const nextDay = new Date('2026-09-24T16:00:00.000Z');
    for (const task of tasks()) {
      await expect(
        answerTodayTask(db, deps, TZ, nextDay, task.id, { recall: 'recalled' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    expect({
      attempts: db.select().from(attempts).all(),
      stats: stats(),
      states: db.select().from(reviewStates).all(),
    }).toEqual(before);
  });

  it('题目未绑定时拒绝作答，不写 attempt 或统计', async () => {
    await seedDueChoiceItem('pending');
    await startTodaySessionRaw(db, deps, TZ, NOW);
    await expect(
      answerTodayTask(db, deps, TZ, NOW, tasks()[0]!.id, { recall: 'recalled' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.select().from(attempts).all()).toEqual([]);
    expect(stats()).toBeNull();
  });
  it('同任务重复提交 → alreadyCompleted=true，不重复写 attempt/推进/计数', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await startSession();
    const task = taskByItem('item-a')!;

    const first = await answerTodayTask(db, deps, TZ, NOW, task.id, { recall: 'recalled' });
    const second = await answerTodayTask(db, deps, TZ, new Date(NOW.getTime() + 60_000), task.id, {
      recall: 'forgot', // 即使换了答案也回放首次结果
    });

    expect(second.alreadyCompleted).toBe(true);
    expect(second.result).toBe('pass');
    expect(second.outcomeSource).toBe('recalled');
    expect(second.correct).toBe(true);
    expect(second.progress).toEqual({ completed: 1, total: 2 });
    expect(db.select().from(attempts).all()).toHaveLength(1);
    expect(stats()?.formalTasksCompleted).toBe(1);
    expect(dim('item-a', 'understanding')!.level).toBe(4); // 未被第二次提交降级
    expect(first.result).toBe(second.result);
  });

  it('已撤销任务再作答 → 409', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const task = taskByItem('item-a')!;
    await answerTodayTask(db, deps, TZ, NOW, task.id, { selectedOptionId: 'o1' });
    db.update(reviewTasks)
      .set({ canceledAt: iso(NOW) })
      .where(eq(reviewTasks.id, task.id))
      .run();
    await expect(
      answerTodayTask(db, deps, TZ, NOW, task.id, { selectedOptionId: 'o1' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('answer：补强上限与降级', () => {
  it('同一 item 单 session 最多 2 道补强：第三次 fail 不再插入', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();

    // 第一次 fail → 补强 1
    const r1 = await answerTodayTask(db, deps, TZ, NOW, taskByItem('item-a')!.id, {
      selectedOptionId: 'o2',
    });
    expect(r1.reinforcementAdded).toBe(true);

    // 补强 1 再 fail → 补强 2
    const rf1 = taskByItem('item-a', { origin: 'reinforcement', pending: true })!;
    const r2 = await answerTodayTask(db, deps, TZ, new Date(NOW.getTime() + 60_000), rf1.id, {
      selectedOptionId: 'o2',
    });
    expect(r2.reinforcementAdded).toBe(true);

    // 补强 2 再 fail → 无补强 3
    const rf2 = taskByItem('item-a', { origin: 'reinforcement', pending: true })!;
    const r3 = await answerTodayTask(db, deps, TZ, new Date(NOW.getTime() + 120_000), rf2.id, {
      selectedOptionId: 'o2',
    });
    expect(r3.reinforcementAdded).toBe(false);
    expect(tasks().filter((t) => t.origin === 'reinforcement')).toHaveLength(2);
    expect(r3.completed).not.toBeNull(); // 全部完成 → 摘要
  });

  it('补强题生成失败 → 跳过补强，不影响结算', async () => {
    await seedItem(db, { id: 'item-a', target: 'item-a', queueState: 'started' });
    await seedReviewState(db, 'item-a', 'understanding', {
      level: 3,
      nextReviewAt: '2026-09-23T00:00:00.000Z',
    });
    // 只有一道题（将被答错的那道），且生成失败
    await seedQuestion(db, 'item-a', {
      type: 'understanding',
      payloadJson: choicePayload(DEFAULT_OPTIONS),
      correctOptionId: 'o1',
    });
    const failing = createFakeDeps({ generateFailFor: new Set(['item-a:understanding']) });
    await startTodaySession(db, failing, TZ, NOW);
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, failing, TZ, NOW, task.id, { selectedOptionId: 'o2' });
    expect(res.result).toBe('fail');
    expect(res.reinforcementAdded).toBe(false);
    expect(tasks().filter((t) => t.origin === 'reinforcement')).toHaveLength(0);
  });

  it('补强插入位置：无剩余任务时 = 当前 sortKey+3+0.5', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const task = taskByItem('item-a')!; // 唯一任务，sortKey 1
    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, { selectedOptionId: 'o2' });
    expect(res.reinforcementAdded).toBe(true);
    const rf = tasks().find((t) => t.origin === 'reinforcement')!;
    expect(rf.sortKey).toBe(4.5); // 1 + 3 + 0.5
  });
});

describe('answer：完成检测与摘要', () => {
  it('全部完成后 session 完成，摘要来自 attempts；fail → recommendRead', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueProductionItem('item-b', 'wear down');
    await startSession();

    const a = taskByItem('item-a')!;
    const b = taskByItem('item-b')!;
    const resA = await answerTodayTask(db, deps, TZ, NOW, a.id, { recall: 'recalled' });
    expect(resA.completed).toBeNull();
    const resB = await answerTodayTask(db, deps, TZ, new Date(NOW.getTime() + 60_000), b.id, {
      answerText: 'wrong',
    });
    expect(resB.reinforcementAdded).toBe(false);
    expect(resB.completed).toEqual({
      totalTasks: 2,
      pass: 1,
      basicPass: 0,
      fail: 1,
      newItemsStarted: 0,
      recommendRead: true,
    });
    expect(db.select().from(reviewSessions).get()?.completedAt).toBe(
      iso(new Date(NOW.getTime() + 60_000)),
    );
    expect(resB.progress).toEqual({ completed: 2, total: 2 });
  });

  it('全部 pass → recommendRead=false', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await startSession();
    const a = taskByItem('item-a')!;
    const b = taskByItem('item-b')!;
    await answerTodayTask(db, deps, TZ, NOW, a.id, { recall: 'recalled' });
    const res = await answerTodayTask(db, deps, TZ, NOW, b.id, { recall: 'recalled' });
    expect(res.completed?.recommendRead).toBe(false);
    expect(res.completed?.pass).toBe(2);
  });
});

describe('answer：L7 stable 与 mastered', () => {
  it('最后一个维度 L7 到期再 pass → stable，两维 stable → item 自动 mastered', async () => {
    await seedItem(db, { id: 'item-a', target: 'item-a', queueState: 'started' });
    await seedReviewState(db, 'item-a', 'understanding', {
      level: 7,
      stable: 0,
      nextReviewAt: '2026-09-23T00:00:00.000Z',
    });
    // P 已 stable（不参与 due 调度）
    await seedReviewState(db, 'item-a', 'production', {
      level: 7,
      stable: 1,
      nextReviewAt: null,
    });
    await seedQuestion(db, 'item-a', {
      type: 'understanding',
      payloadJson: choicePayload(DEFAULT_OPTIONS),
      correctOptionId: 'o1',
    });
    await startSession();

    const u = tasks().find((t) => t.taskType === 'understanding')!;
    const res = await answerTodayTask(db, deps, TZ, NOW, u.id, { recall: 'recalled' });
    expect(res.result).toBe('pass');

    const item = db.select().from(learningItems).where(eq(learningItems.id, 'item-a')).get()!;
    expect(item.status).toBe('mastered');
    expect(dim('item-a', 'understanding')!.stable).toBe(1);
    expect(dim('item-a', 'understanding')!.level).toBe(7);
  });
});

describe('answer：understanding Recall 判定（三档证据）', () => {
  it('recalled：body.recall=recalled → result=pass、advance kind=pass（升级）、attempt.outcome_source=recalled', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, { recall: 'recalled' });
    expect(res.result).toBe('pass');
    expect(res.outcomeSource).toBe('recalled');
    expect(res.correct).toBe(true);
    // kind=pass：L3 → L4
    expect(dim('item-a', 'understanding')!.level).toBe(4);

    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.outcomeSource).toBe('recalled');
    expect(attempt.result).toBe('pass');
    expect(attempt.selectedOptionId).toBeNull();
  });

  it('forgot：body.recall=forgot → result=fail、补强插入（quota 允许时）、attempt.outcome_source=forgot', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b'); // 保持会话未完成
    await startSession();
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, { recall: 'forgot' });
    expect(res.result).toBe('fail');
    expect(res.outcomeSource).toBe('forgot');
    expect(res.reinforcementAdded).toBe(true);
    // kind=fail：L3 → L2
    expect(dim('item-a', 'understanding')!.level).toBe(2);

    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.outcomeSource).toBe('forgot');
    expect(attempt.result).toBe('fail');
  });

  it('assisted：hintUsed+选对 → result=basic_pass、outcome_source=assisted；不因 viewedSource 变化（false 同样 basic_pass）', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await startSession();
    const a = taskByItem('item-a')!; // sortKey 1
    const b = taskByItem('item-b')!; // sortKey 2

    const withViewed = await answerTodayTask(db, deps, TZ, NOW, a.id, {
      selectedOptionId: 'o1',
      hintUsed: true,
      viewedSource: true,
    });
    expect(withViewed.result).toBe('basic_pass');
    expect(withViewed.outcomeSource).toBe('assisted');

    const withoutViewed = await answerTodayTask(db, deps, TZ, NOW, b.id, {
      selectedOptionId: 'o1',
      hintUsed: true,
      viewedSource: false,
    });
    expect(withoutViewed.result).toBe('basic_pass');
    expect(withoutViewed.outcomeSource).toBe('assisted');

    // kind=basic_pass：不升级
    expect(dim('item-a', 'understanding')!.level).toBe(3);
    expect(dim('item-b', 'understanding')!.level).toBe(3);
  });

  it('hint 后选错 → result=fail、outcome_source=forgot、揭示正确项', async () => {
    await seedDueChoiceItem('item-a', 3, '解释文本');
    await seedDueChoiceItem('item-b');
    await startSession();
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, {
      selectedOptionId: 'o2',
      hintUsed: true,
    });
    expect(res.result).toBe('fail');
    expect(res.outcomeSource).toBe('forgot');
    expect(res.correct).toBe(false);
    expect(res.correctOptionId).toBe('o1');
    expect(res.explanation).toBe('解释文本');
    // kind=fail：L3 → L2
    expect(dim('item-a', 'understanding')!.level).toBe(2);
  });

  it('easy（2026-10-03 三档自评「简单」）：result=pass、correct=true、outcomeSource=easy，U 跳两步且 streak/统计按 pass', async () => {
    await seedDueChoiceItem('item-a'); // L3
    await startSession();
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, { recall: 'easy' });
    expect(res.result).toBe('pass');
    expect(res.outcomeSource).toBe('easy');
    expect(res.correct).toBe(true);
    expect(res.explanation).toBeNull(); // 答对不揭示解释
    // 计入通过统计（result=pass → 摘要 pass、daily_stats formal）
    expect(res.completed).toMatchObject({ pass: 1, fail: 0 });
    expect(stats()).toMatchObject({ formalTasksCompleted: 1, newItemsStarted: 0 });

    // U 跳两步：L3 → L5（recalled 对照只到 L4），next = L5 间隔 30 天
    const u = dim('item-a', 'understanding')!;
    expect(u.level).toBe(5);
    expect(u.stable).toBe(0);
    expect(u.nextReviewAt).toBe(iso(new Date(NOW.getTime() + 30 * DAY_MS)));
    // streak 按 pass：记对、清错
    expect(u.correctStreak).toBe(1);
    expect(u.wrongStreak).toBe(0);

    // attempt 落库 outcome_source=easy（沿用 attempt 元数据机制）
    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.result).toBe('pass');
    expect(attempt.outcomeSource).toBe('easy');
    expect(attempt.selectedOptionId).toBeNull();
  });

  it('easy 在 ladder 顶端封顶：L6（60 天档）easy → L7/120 天，不越界、不提前 stable', async () => {
    await seedDueChoiceItem('item-a', 6);
    await startSession();
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, { recall: 'easy' });
    expect(res.result).toBe('pass');

    const u = dim('item-a', 'understanding')!;
    expect(u.level).toBe(7); // min(6+2, 7)
    expect(u.stable).toBe(0); // 与 pass 相同：L7 到期再答才 stable
    expect(u.nextReviewAt).toBe(iso(new Date(NOW.getTime() + 120 * DAY_MS)));
  });

  it('幂等回放：重复提交返回首次 outcomeSource', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const task = taskByItem('item-a')!;

    const first = await answerTodayTask(db, deps, TZ, NOW, task.id, { recall: 'recalled' });
    expect(first.outcomeSource).toBe('recalled');

    const replay = await answerTodayTask(db, deps, TZ, new Date(NOW.getTime() + 60_000), task.id, {
      recall: 'forgot', // 换答案仍回放首次结算
    });
    expect(replay.alreadyCompleted).toBe(true);
    expect(replay.result).toBe('pass');
    expect(replay.outcomeSource).toBe('recalled');
  });
});

describe('learn Recall（初见即回忆，方案 A）', () => {
  /** 断言两维行均按新学初始化：U=L1、P=L0，next_review_at 均为明日 */
  function expectInitializedDims(itemId: string): void {
    const u = dim(itemId, 'understanding')!;
    const p = dim(itemId, 'production')!;
    expect(u.level).toBe(1);
    expect(u.nextReviewAt).toBe(iso(new Date(NOW.getTime() + DAY_MS)));
    expect(p.level).toBe(0);
    expect(p.nextReviewAt).toBe(iso(new Date(NOW.getTime() + DAY_MS)));
  }

  it('recalled：初始化 U+P、result=pass、outcomeSource=recalled、额度+1', async () => {
    await seedLearnItem('new-1');
    await startSession();
    const learn = taskByItem('new-1', { type: 'learn' })!;

    const res = await answerTodayTask(db, deps, TZ, NOW, learn.id, { recall: 'recalled' });
    expect(res.result).toBe('pass');
    expect(res.outcomeSource).toBe('recalled');
    expect(res.correct).toBe(true);

    expectInitializedDims('new-1');
    expect(stats()).toMatchObject({ formalTasksCompleted: 1, newItemsStarted: 1 });
    const session = db.select().from(reviewSessions).get()!;
    expect(session.newItemsStarted).toBe(1);
  });

  it('forgot：同样初始化 U+P、result=fail、outcomeSource=forgot、额度+1（揭示即教学）', async () => {
    await seedLearnItem('new-1');
    await startSession();
    const learn = taskByItem('new-1', { type: 'learn' })!;

    const res = await answerTodayTask(db, deps, TZ, NOW, learn.id, { recall: 'forgot' });
    expect(res.result).toBe('fail');
    expect(res.outcomeSource).toBe('forgot');
    expect(res.correct).toBe(false);
    expect(res.correctOptionId).toBe('o1'); // 揭示正确项 = 揭示即教学

    expectInitializedDims('new-1');
    expect(stats()).toMatchObject({ formalTasksCompleted: 1, newItemsStarted: 1 });
  });

  it('easy：等同 pass——初始 U 状态与 recalled 相同（首学不跳两步）、outcomeSource=easy、额度+1', async () => {
    await seedLearnItem('new-1');
    await startSession();
    const learn = taskByItem('new-1', { type: 'learn' })!;

    const res = await answerTodayTask(db, deps, TZ, NOW, learn.id, { recall: 'easy' });
    expect(res.result).toBe('pass');
    expect(res.outcomeSource).toBe('easy');
    expect(res.correct).toBe(true);

    expectInitializedDims('new-1'); // U=L1、next=+1d，与 recalled/pass 完全一致
    expect(stats()).toMatchObject({ formalTasksCompleted: 1, newItemsStarted: 1 });
  });

  it('hint 选对：初始化、result=basic_pass、outcomeSource=assisted', async () => {
    await seedLearnItem('new-1');
    await startSession();
    const learn = taskByItem('new-1', { type: 'learn' })!;

    const res = await answerTodayTask(db, deps, TZ, NOW, learn.id, {
      selectedOptionId: 'o1',
      hintUsed: true,
    });
    expect(res.result).toBe('basic_pass');
    expect(res.outcomeSource).toBe('assisted');
    expect(res.correct).toBe(true);

    expectInitializedDims('new-1');
  });

  it('hint 选错：初始化、result=fail、outcomeSource=forgot', async () => {
    await seedLearnItem('new-1');
    await startSession();
    const learn = taskByItem('new-1', { type: 'learn' })!;

    const res = await answerTodayTask(db, deps, TZ, NOW, learn.id, {
      selectedOptionId: 'o2',
      hintUsed: true,
    });
    expect(res.result).toBe('fail');
    expect(res.outcomeSource).toBe('forgot');
    expect(res.correct).toBe(false);
    expect(res.correctOptionId).toBe('o1');

    expectInitializedDims('new-1');
  });

  it('learn fail 不插入同会话补强任务', async () => {
    await seedLearnItem('new-1');
    await startSession();
    const learn = taskByItem('new-1', { type: 'learn' })!;

    const res = await answerTodayTask(db, deps, TZ, NOW, learn.id, { recall: 'forgot' });
    expect(res.result).toBe('fail');
    expect(res.reinforcementAdded).toBe(false);
    expect(tasks().filter((t) => t.origin === 'reinforcement')).toHaveLength(0);
    expect(res.progress).toEqual({ completed: 1, total: 1 });
    // 会话直接完成：fail 仍计入摘要（recommendRead）
    expect(res.completed).toMatchObject({ totalTasks: 1, fail: 1, newItemsStarted: 1 });
  });

  it('learn 旧式纯 selectedOptionId（无 hintUsed）按 hint 语义结算', async () => {
    await seedLearnItem('new-1');
    await seedLearnItem('new-2');
    await startSession();

    // 选对：无 hintUsed 也按 hint 语义 → basic_pass/assisted（不再走旧 correct→pass）
    const right = await answerTodayTask(
      db,
      deps,
      TZ,
      NOW,
      taskByItem('new-1', { type: 'learn' })!.id,
      { selectedOptionId: 'o1' },
    );
    expect(right.result).toBe('basic_pass');
    expect(right.outcomeSource).toBe('assisted');

    // 选错：→ fail/forgot
    const wrong = await answerTodayTask(
      db,
      deps,
      TZ,
      NOW,
      taskByItem('new-2', { type: 'learn' })!.id,
      { selectedOptionId: 'o9' },
    );
    expect(wrong.result).toBe('fail');
    expect(wrong.outcomeSource).toBe('forgot');

    expectInitializedDims('new-1');
    expectInitializedDims('new-2');
  });
});

describe('answer：主动不会（giveUp）', () => {
  /** 统计生产批改调用次数的 deps（验证 give-up 零批改） */
  function countingDeps(base: TodayDeps = createFakeDeps()): {
    deps: TodayDeps;
    calls: { production: number };
  } {
    const calls = { production: 0 };
    const deps: TodayDeps = {
      ...base,
      evaluateProduction: async (db, question, answerText) => {
        calls.production += 1;
        return base.evaluateProduction(db, question, answerText);
      },
    };
    return { deps, calls };
  }

  it('understanding give-up → fail/forgot：走既有 fail 结算（降级+补强），feedback=gave_up，零判定调用', async () => {
    const { deps, calls } = countingDeps();
    await seedDueChoiceItem('item-a');
    await startTodaySession(db, deps, TZ, NOW);
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, { giveUp: true });
    expect(res.result).toBe('fail');
    expect(res.correct).toBe(false);
    expect(res.gaveUp).toBe(true);
    expect(res.outcomeSource).toBe('forgot');
    // 选择题揭示：正确选项 + 解释（揭示即教学）
    expect(res.correctOptionId).toBe('o1');
    expect(res.explanation).toBe('解释文本');
    // give-up 无提交答案，也不携带表达题参考字段
    expect(res.selectedOptionId ?? null).toBeNull();
    expect(res.submittedAnswerText ?? null).toBeNull();
    expect(res.referenceAnswer ?? null).toBeNull();
    expect(res.answerNote ?? null).toBeNull();
    expect(res.correction).toBeNull();
    // 既有 fail 结算：L3 → L2 + 补强
    expect(res.reinforcementAdded).toBe(true);
    expect(dim('item-a', 'understanding')!.level).toBe(2);
    expect(stats()).toMatchObject({ formalTasksCompleted: 1 });

    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.feedback).toBe('gave_up');
    expect(attempt.result).toBe('fail');
    expect(attempt.answerText).toBeNull();
    expect(attempt.selectedOptionId).toBeNull();
    expect(attempt.aiPromptKey).toBeNull();
    expect(calls.production).toBe(0);
  });

  it('cloze give-up → fail：揭示完整句/可接受答案/解释，attempt 不含提交文本', async () => {
    await seedDueClozeItem('item-a', ['raw']);
    await startTodaySession(db, deps, TZ, NOW);
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, { giveUp: true });
    expect(res.result).toBe('fail');
    expect(res.gaveUp).toBe(true);
    expect(res.outcomeSource ?? null).toBeNull();
    expect(res.completeSentence).toBe('We need the raw item-a before processing.');
    expect(res.acceptedAnswer).toBe('raw');
    expect(res.explanation).toBe('cloze 解释');
    expect(res.correctOptionId ?? null).toBeNull();
    expect(res.submittedAnswerText ?? null).toBeNull();
    // 既有 fail 结算：填空 fail 插补强
    expect(res.reinforcementAdded).toBe(true);

    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.feedback).toBe('gave_up');
    expect(attempt.answerText).toBeNull();
  });

  it('production give-up → fail：referenceAnswer/answerNote 来自题目 payload，零批改、无 diff、无沉淀', async () => {
    const { deps, calls } = countingDeps();
    await seedDueProductionItem('item-a', 'wear down');
    await startTodaySession(db, deps, TZ, NOW);
    const task = taskByItem('item-a')!;

    const res = await answerTodayTask(db, deps, TZ, NOW, task.id, { giveUp: true });
    expect(res.result).toBe('fail');
    expect(res.correct).toBe(false);
    expect(res.gaveUp).toBe(true);
    expect(res.referenceAnswer).toBe('They wear down naturally.');
    expect(res.answerNote).toBe('允许正常时态变化。');
    expect(res.correction).toBeNull();
    expect(res.explanation ?? null).toBeNull();
    expect(res.submittedAnswerText ?? null).toBeNull();
    expect(res.reinforcementAdded).toBe(false);
    expect(res.completed).toMatchObject({ totalTasks: 1, fail: 1, recommendRead: true });

    // 统计沿用既有 fail 规则：计作答、不计通过；未写句子不沉淀 Personal Example
    expect(stats()).toMatchObject({ productionAttempts: 1, productionPass: 0 });
    expect(
      db
        .select()
        .from(learningExamples)
        .all()
        .filter((e) => e.kind === 'personal'),
    ).toHaveLength(0);

    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.feedback).toBe('gave_up');
    expect(attempt.answerText).toBeNull();
    expect(attempt.correctionJson).toBeNull();
    expect(attempt.aiPromptKey).toBeNull();
    expect(calls.production).toBe(0);
  });

  it('learn give-up → 新学照常（U/P 初始化、started、额度+1）、outcomeSource=forgot、不插补强', async () => {
    await seedLearnItem('new-1');
    await startTodaySession(db, deps, TZ, NOW);
    const learn = taskByItem('new-1', { type: 'learn' })!;

    const res = await answerTodayTask(db, deps, TZ, NOW, learn.id, { giveUp: true });
    expect(res.result).toBe('fail');
    expect(res.outcomeSource).toBe('forgot');
    expect(res.correctOptionId).toBe('o1'); // 揭示即教学
    expect(res.reinforcementAdded).toBe(false);

    expect(dim('new-1', 'understanding')!.level).toBe(1);
    expect(dim('new-1', 'production')!.level).toBe(0);
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'new-1')).get()?.queueState,
    ).toBe('started');
    expect(stats()).toMatchObject({ formalTasksCompleted: 1, newItemsStarted: 1 });
  });

  it('giveUp 与 option/text/recall/hint 互斥 → VALIDATION_ERROR 且零写入', async () => {
    await seedDueChoiceItem('item-a');
    await startTodaySession(db, deps, TZ, NOW);
    const task = taskByItem('item-a')!;

    for (const extra of [
      { selectedOptionId: 'o1' },
      { answerText: 'x' },
      { recall: 'recalled' as const },
      { hintUsed: true },
    ]) {
      await expect(
        answerTodayTask(db, deps, TZ, NOW, task.id, { giveUp: true, ...extra }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(db.select().from(attempts).all()).toHaveLength(0);
    expect(tasks()[0]!.completedAt).toBeNull();
  });

  it('缺答案且无 giveUp（含 giveUp=false）→ 仍按缺答案拒绝', async () => {
    await seedDueChoiceItem('item-a');
    await startTodaySession(db, deps, TZ, NOW);
    const task = taskByItem('item-a')!;
    await expect(answerTodayTask(db, deps, TZ, NOW, task.id, {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('幂等回放保留 giveUp 与已提交答案：揭示/提交字段与首次结算一致', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueProductionItem('item-b', 'wear down');
    await startTodaySession(db, deps, TZ, NOW);
    const choice = taskByItem('item-a')!;
    const prod = taskByItem('item-b')!;

    const giveUp = await answerTodayTask(db, deps, TZ, NOW, choice.id, { giveUp: true });
    const genuine = await answerTodayTask(db, deps, TZ, NOW, prod.id, {
      answerText: 'I wear down easily.',
    });
    expect(genuine.gaveUp).toBe(false);
    expect(genuine.submittedAnswerText).toBe('I wear down easily.');
    expect(genuine.referenceAnswer ?? null).toBeNull();
    expect(genuine.answerNote ?? null).toBeNull();

    const later = new Date(NOW.getTime() + 60_000);
    const replayGiveUp = await answerTodayTask(db, deps, TZ, later, choice.id, {
      selectedOptionId: 'o2',
    });
    expect(replayGiveUp.alreadyCompleted).toBe(true);
    expect(replayGiveUp.gaveUp).toBe(true);
    expect(replayGiveUp.result).toBe(giveUp.result);
    expect(replayGiveUp.correctOptionId).toBe(giveUp.correctOptionId);
    expect(replayGiveUp.explanation).toBe(giveUp.explanation);
    expect(replayGiveUp.selectedOptionId ?? null).toBeNull();
    expect(replayGiveUp.submittedAnswerText ?? null).toBeNull();

    const replayGenuine = await answerTodayTask(db, deps, TZ, later, prod.id, {});
    expect(replayGenuine.alreadyCompleted).toBe(true);
    expect(replayGenuine.gaveUp).toBe(false);
    expect(replayGenuine.submittedAnswerText).toBe('I wear down easily.');
    expect(replayGenuine.selectedOptionId ?? null).toBeNull();
    expect(replayGenuine.referenceAnswer ?? null).toBeNull();
    expect(replayGenuine.answerNote ?? null).toBeNull();
    expect(replayGenuine.correction).toEqual(genuine.correction);
    expect(replayGenuine.personalExampleSaved).toBe(genuine.personalExampleSaved);
  });
});
