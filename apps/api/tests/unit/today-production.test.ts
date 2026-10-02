import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TodayTaskView } from '@el/shared';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  attempts,
  dailyStats,
  learningExamples,
  reviewStates,
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
import { seedItem, seedQuestion, seedReviewState } from '../helpers/seed';
import { createFakeDeps, type FakeDepsOptions } from '../helpers/today-fakes';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-09-24T02:00:00.000Z');
const DAY_MS = 24 * 3600 * 1000;
const DUE = '2026-09-23T00:00:00.000Z';
const iso = (d: Date) => d.toISOString();

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

/** 表达题种子：item + P 维度到期状态 + 一道 production 题 */
async function seedProductionItem(
  itemId: string,
  level: number,
  opts: { mustUse?: string } = {},
): Promise<string> {
  const mustUse = opts.mustUse ?? itemId;
  await seedItem(db, { id: itemId, type: 'chunk', target: itemId, queueState: 'started' });
  await seedReviewState(db, itemId, 'production', { level, nextReviewAt: DUE });
  await seedQuestion(db, itemId, {
    id: `${itemId}-prod`,
    type: 'production',
    promptText: `请使用 ${mustUse} 表达这个意思。`,
    payloadJson: JSON.stringify({
      mustUse,
      referenceAnswer: `They ${mustUse} naturally.`,
      acceptanceNotes: '允许变化。',
    }),
    correctOptionId: null,
  });
  await seedQuestion(db, itemId, {
    id: `${itemId}-cloze`,
    type: 'cloze',
    payloadJson: JSON.stringify({ acceptedAnswers: [mustUse], explanation: 'cloze 解释' }),
    promptText: `We ____ ${mustUse} here.`,
    correctOptionId: null,
  });
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

describe('P 维度题型映射（TodayTaskView）', () => {
  it('P-L1 / P-L2 → production 任务，即使旧 cloze 库存存在', async () => {
    await seedProductionItem('item-l1', 1);
    await seedProductionItem('item-l2', 2);
    await startTodaySession(db, deps(), TZ, NOW);
    const byItem = new Map(
      db
        .select()
        .from(reviewTasks)
        .all()
        .map((t) => [t.learningItemId, t]),
    );
    expect(byItem.get('item-l1')!.taskType).toBe('production');
    expect(byItem.get('item-l2')!.taskType).toBe('production');
    expect(byItem.get('item-l1')!.questionId).toBe('item-l1-prod');
    expect(byItem.get('item-l2')!.questionId).toBe('item-l2-prod');
  });

  it('P-L4+ → production 任务，视图只含 zhPrompt/mustUse，不泄露 referenceAnswer', async () => {
    await seedProductionItem('item-l4', 4);
    const task = await startAndGet();
    expect(task.taskType).toBe('production');
    expect(task.dimension).toBe('production');
    expect(task.question).toMatchObject({
      questionId: 'item-l4-prod',
      zhPrompt: '请使用 item-l4 表达这个意思。',
      mustUse: 'item-l4',
    });
    expect(JSON.stringify(task.question)).not.toContain('referenceAnswer');
    expect(JSON.stringify(task.question)).not.toContain('They item-l4 naturally.');
  });

  it('P-L3 不再混合，所有词条只取 production', async () => {
    await seedProductionItem('m-a', 3);
    await seedProductionItem('m-b', 3);
    await startTodaySession(db, deps(), TZ, NOW);
    const byItem = new Map(
      db
        .select()
        .from(reviewTasks)
        .all()
        .map((t) => [t.learningItemId, t]),
    );
    expect(byItem.get('m-a')!.taskType).toBe('production');
    expect(byItem.get('m-b')!.taskType).toBe('production');
    expect(byItem.get('m-a')!.questionId).toBe('m-a-prod');
    expect(byItem.get('m-b')!.questionId).toBe('m-b-prod');
  });
});

describe('today production answer', () => {
  async function answerOne(
    itemId: string,
    answerText: string,
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
    return answerTodayTask(db, d, TZ, NOW, task.id, { answerText });
  }

  it('pass：L4→L5 推进、attempt 记录 correction/explanation/better/prompt 元数据、统计、沉淀 personal example', async () => {
    await seedProductionItem('item-p', 4);
    const res = await answerOne('item-p', 'I will never give item-p up today.');

    expect(res.result).toBe('pass');
    expect(res.correct).toBe(true);
    expect(res.correction).toEqual({
      segments: [{ text: 'I will never give item-p up today.', type: 'same' }],
      correctedSentence: 'I will never give item-p up today.',
      betterVersion: null,
    });
    expect(res.personalExampleSaved).toBe(true);

    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'item-p'))
      .all()
      .find((r) => r.dimension === 'production')!;
    expect(p.level).toBe(5);
    expect(p.nextReviewAt).toBe(iso(new Date(NOW.getTime() + 30 * DAY_MS)));

    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.mode).toBe('today');
    expect(attempt.answerText).toBe('I will never give item-p up today.');
    expect(attempt.result).toBe('pass');
    const correction = JSON.parse(attempt.correctionJson!) as {
      segments: { type: string }[];
      corrected: string;
      better: string | null;
    };
    expect(correction.segments).toEqual([
      { text: 'I will never give item-p up today.', type: 'same' },
    ]);
    expect(correction.corrected).toBe('I will never give item-p up today.');
    expect(attempt.explanation).toBe('fake：目标使用正确。');
    expect(attempt.betterVersion).toBeNull();
    expect(attempt.aiPromptKey).toBe('check_production');
    expect(attempt.aiPromptVersion).toBe(1);
    expect(attempt.aiPromptHash).toBe('fake-hash');
    expect(attempt.aiModel).toBe('fake');

    const stats = db.select().from(dailyStats).get()!;
    expect(stats.formalTasksCompleted).toBe(1);
    expect(stats.productionAttempts).toBe(1);
    expect(stats.productionPass).toBe(1);

    // Personal Example 已写入，post 快照记录 exampleId
    const examples = db
      .select()
      .from(learningExamples)
      .where(eq(learningExamples.learningItemId, 'item-p'))
      .all();
    expect(examples.filter((e) => e.kind === 'personal')).toHaveLength(1);
    const post = JSON.parse(attempt.postStateJson!) as { personalExampleId: string | null };
    expect(post.personalExampleId).toBe(examples.find((e) => e.kind === 'personal')!.id);
  });

  it('basic_pass：不升级、productionPass 不计', async () => {
    await seedProductionItem('item-bp', 4);
    const basicDeps = deps({
      productionEval: (question, answerText) => ({
        result: 'basic_pass',
        correctedSentence: `Fixed ${answerText}`,
        segments: [
          { text: answerText, type: 'delete' },
          { text: `Fixed ${answerText}`, type: 'insert' },
        ],
        explanation: '轻微语法问题。',
        betterVersion: 'Even better.',
        candidate: { eligible: false, qualityScore: 0.2, reason: 'fake' },
        promptMeta: { key: 'check_production', version: 1, hash: 'fake-hash', model: 'fake' },
      }),
    });
    const res = await answerOne('item-bp', 'i give item-bp up', basicDeps);

    expect(res.result).toBe('basic_pass');
    expect(res.correct).toBe(true);
    expect(res.correction?.correctedSentence).toBe('Fixed i give item-bp up');
    expect(res.correction?.betterVersion).toBe('Even better.');
    expect(res.personalExampleSaved).toBe(false); // eligible=false

    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'item-bp'))
      .all()
      .find((r) => r.dimension === 'production')!;
    expect(p.level).toBe(4); // 不升级
    expect(p.nextReviewAt).toBe(iso(new Date(NOW.getTime() + 7 * DAY_MS))); // L4 间隔 14d × 0.5 = 7d

    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.betterVersion).toBe('Even better.');
    const stats = db.select().from(dailyStats).get()!;
    expect(stats.productionAttempts).toBe(1);
    expect(stats.productionPass).toBe(0);
  });

  it('fail：降级且不插补强任务（表达题不强制当天重做）', async () => {
    await seedProductionItem('item-f', 4);
    const res = await answerOne('item-f', 'nothing relevant');

    expect(res.result).toBe('fail');
    expect(res.correct).toBe(false);
    expect(res.reinforcementAdded).toBe(false);
    expect(res.correction?.correctedSentence).toBe('They item-f naturally.');
    expect(res.personalExampleSaved).toBe(false);

    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'item-f'))
      .all()
      .find((r) => r.dimension === 'production')!;
    expect(p.level).toBe(3); // L4 → L3

    expect(db.select().from(reviewTasks).all()).toHaveLength(1); // 无补强
    expect(
      db
        .select()
        .from(learningExamples)
        .all()
        .filter((e) => e.kind === 'personal'),
    ).toHaveLength(0);
    const stats = db.select().from(dailyStats).get()!;
    expect(stats.productionAttempts).toBe(1);
    expect(stats.productionPass).toBe(0);
  });

  it('批改失败：抛 AI_PROVIDER_ERROR 且零写入（无 attempt/无推进/任务未完成/无统计）', async () => {
    await seedProductionItem('item-x', 4);
    const failing = deps({ productionFail: true });
    await expect(answerOne('item-x', 'some answer', failing)).rejects.toMatchObject({
      code: 'AI_PROVIDER_ERROR',
      message: '批改失败，请重试',
    });

    expect(db.select().from(attempts).all()).toHaveLength(0);
    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'item-x'))
      .all()
      .find((r) => r.dimension === 'production')!;
    expect(p.level).toBe(4);
    expect(db.select().from(reviewTasks).all()[0]!.completedAt).toBeNull();
    expect(db.select().from(dailyStats).all()).toHaveLength(0);
  });

  it('幂等回放：重复提交返回首次 correction 与 personalExampleSaved，不重复写入', async () => {
    await seedProductionItem('item-r', 4);
    const d = deps();
    const started = await startTodaySession(db, d, TZ, NOW);
    if (started.status !== 'active') throw new Error('start 失败');
    const task = db.select().from(reviewTasks).all()[0]!;

    const first = await answerTodayTask(db, d, TZ, NOW, task.id, {
      answerText: 'I give item-r up.',
    });
    expect(first.personalExampleSaved).toBe(true);
    const second = await answerTodayTask(db, d, TZ, new Date(NOW.getTime() + 60_000), task.id, {
      answerText: 'different answer',
    });

    expect(second.alreadyCompleted).toBe(true);
    expect(second.result).toBe(first.result);
    expect(second.correction).toEqual(first.correction);
    expect(second.personalExampleSaved).toBe(true);
    expect(db.select().from(attempts).all()).toHaveLength(1);
    // personal example 仍只有 1 条
    expect(
      db
        .select()
        .from(learningExamples)
        .all()
        .filter((e) => e.kind === 'personal'),
    ).toHaveLength(1);
  });

  it('表达题必须提交 answerText，否则 400', async () => {
    await seedProductionItem('item-v', 4);
    const d = deps();
    await startTodaySession(db, d, TZ, NOW);
    const task = db.select().from(reviewTasks).all()[0]!;
    await expect(
      answerTodayTask(db, d, TZ, NOW, task.id, { selectedOptionId: 'o1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('造句历史裁剪：第 11 条 production attempt 插入后最旧被删', async () => {
    const itemId = await seedProductionItem('item-h', 4);
    // 预置 10 条历史 production attempts（today 模式）
    for (let i = 0; i < 10; i++) {
      db.insert(attempts)
        .values({
          id: `old-${i}`,
          reviewTaskId: null,
          learningItemId: itemId,
          questionId: 'item-h-prod',
          mode: 'today',
          answerText: `Old ${i}`,
          selectedOptionId: null,
          result: 'pass',
          viewedSource: 0,
          feedback: null,
          correctionJson: JSON.stringify({
            segments: [{ text: `Old ${i}`, type: 'same' }],
            corrected: `Old ${i}`,
            better: null,
          }),
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
    const res = await answerOne('item-h', 'I give item-h up.');
    expect(res.result).toBe('pass');

    const rows = db.select().from(attempts).where(eq(attempts.learningItemId, itemId)).all();
    expect(rows).toHaveLength(10); // 10 旧 + 1 新 → 裁剪最旧
    expect(rows.map((r) => r.id)).not.toContain('old-0');
    expect(rows.map((r) => r.id)).toContain('old-1');
  });
});

describe('production 与 bad-question / feedback', () => {
  async function answerProductionTask(itemId: string): Promise<string> {
    const d = deps();
    const started = await startTodaySession(db, d, TZ, NOW);
    if (started.status !== 'active') throw new Error('start 失败');
    const task = db
      .select()
      .from(reviewTasks)
      .where(eq(reviewTasks.learningItemId, itemId))
      .all()[0]!;
    await answerTodayTask(db, d, TZ, NOW, task.id, { answerText: `I use ${itemId} well.` });
    return task.id;
  }

  it('feedback：production 任务拒绝（400）', async () => {
    await seedProductionItem('item-fb', 4);
    const taskId = await answerProductionTask('item-fb');
    await expect(async () =>
      submitTaskFeedback(db, deps(), TZ, taskId, 'guessed', new Date(NOW.getTime() + 60_000)),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: '表达题不支持该反馈' });
    await expect(async () =>
      submitTaskFeedback(db, deps(), TZ, taskId, 'too_easy', new Date(NOW.getTime() + 60_000)),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('bad-question：撤销时删除本次写入的 personal example', async () => {
    await seedProductionItem('item-bq', 4);
    const taskId = await answerProductionTask('item-bq');
    const attempt = db.select().from(attempts).all()[0]!;
    const post = JSON.parse(attempt.postStateJson!) as { personalExampleId: string };
    expect(post.personalExampleId).toBeTruthy();

    const res = reportBadQuestion(db, taskId, new Date(NOW.getTime() + 120_000), TZ);
    expect(res.ok).toBe(true);
    expect(
      db
        .select()
        .from(learningExamples)
        .where(eq(learningExamples.id, post.personalExampleId))
        .get(),
    ).toBeUndefined();
    // 状态回滚 L4（pre）
    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'item-bq'))
      .all()
      .find((r) => r.dimension === 'production')!;
    expect(p.level).toBe(4);
  });

  it.each([
    { answerText: 'I use item-stats well.', result: 'pass', productionPass: 1 },
    { answerText: 'An unrelated answer.', result: 'fail', productionPass: 0 },
  ])('bad-question：$result 回减表达统计且重复请求不重复扣减', async (testCase) => {
    await seedProductionItem('item-stats', 4);
    const d = deps();
    await startTodaySession(db, d, TZ, NOW);
    const task = db.select().from(reviewTasks).all()[0]!;
    await answerTodayTask(db, d, TZ, NOW, task.id, { answerText: testCase.answerText });
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
      expect(db.select().from(reviewStates).get()).toMatchObject({
        dimension: 'production',
        level: 4,
        nextReviewAt: DUE,
      });
    }
  });

  it('bad-question：example 已被用户 pinned → 不删除', async () => {
    await seedProductionItem('item-pin', 4);
    const taskId = await answerProductionTask('item-pin');
    const attempt = db.select().from(attempts).all()[0]!;
    const post = JSON.parse(attempt.postStateJson!) as { personalExampleId: string };
    db.update(learningExamples)
      .set({ pinned: 1 })
      .where(eq(learningExamples.id, post.personalExampleId))
      .run();

    reportBadQuestion(db, taskId, new Date(NOW.getTime() + 120_000), TZ);
    expect(
      db
        .select()
        .from(learningExamples)
        .where(eq(learningExamples.id, post.personalExampleId))
        .get(),
    ).toBeTruthy();
  });
});
