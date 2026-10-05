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
  undoTodayTask,
  type TodayDeps,
} from '../../src/modules/today/service.js';
import { requestDisconnected } from '../../src/modules/today/routes.js';
import type { ProductionEvaluation } from '../../src/modules/questions/service.js';
import { seedItem, seedQuestion, seedReviewState } from '../helpers/seed';
import { createFakeDeps, type FakeDepsOptions } from '../helpers/today-fakes';

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

/** 表达题种子：item + P 维度到期状态（旧 level 档 → FSRS stability：1→2、2→5、4→25）+ 一道 production 题 */
async function seedProductionItem(
  itemId: string,
  stability: number,
  opts: { mustUse?: string } = {},
): Promise<string> {
  const mustUse = opts.mustUse ?? itemId;
  await seedItem(db, { id: itemId, type: 'chunk', target: itemId, queueState: 'started' });
  await seedReviewState(db, itemId, 'production', {
    difficulty: 5,
    stability,
    reps: 4,
    lapses: 0,
    nextReviewAt: DUE,
    lastReviewAt: '2026-09-20T00:00:00.000Z',
  });
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
    await seedProductionItem('item-l1', 2);
    await seedProductionItem('item-l2', 5);
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
    await seedProductionItem('item-l4', 25);
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
    await seedProductionItem('item-p', 25);
    const res = await answerOne('item-p', 'I will never give item-p up today.');

    expect(res.result).toBe('pass');
    expect(res.correct).toBe(true);
    expect(res.correction).toEqual({
      segments: [{ text: 'I will never give item-p up today.', type: 'same' }],
      correctedSentence: 'I will never give item-p up today.',
      betterVersion: null,
      betterVersionKind: null,
    });
    expect(res.personalExampleSaved).toBe(true);

    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'item-p'))
      .all()
      .find((r) => r.dimension === 'production')!;
    expect(p.reps).toBe(5); // Good：reps 累计
    expect(Date.parse(p.nextReviewAt!)).toBeGreaterThan(NOW.getTime() + DAY_MS); // Good 间隔（S25 起点 ≈ +27 天）

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
    await seedProductionItem('item-bp', 25);
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
        betterVersionKind: 'polish',
        candidate: { eligible: false, source: null, qualityScore: 0.2, reason: 'fake' },
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
    expect(p.correctStreak).toBe(0); // basic_pass 不记对
    expect(Date.parse(p.nextReviewAt!)).toBeGreaterThanOrEqual(NOW.getTime() + DAY_MS); // Hard 间隔短于 Good // L4 间隔 14d × 0.5 = 7d

    const attempt = db.select().from(attempts).all()[0]!;
    expect(attempt.betterVersion).toBe('Even better.');
    const stats = db.select().from(dailyStats).get()!;
    expect(stats.productionAttempts).toBe(1);
    expect(stats.productionPass).toBe(0);
  });

  it('polish 版本作为实际 personal example 保存，且撤销识别该准确文本', async () => {
    await seedProductionItem('item-polish', 25);
    const polishDeps = deps({
      productionEval: (_question, _answerText) => ({
        result: 'pass',
        correctedSentence: 'Daily pressure wears down my resolve.',
        segments: [
          { text: 'Daily pressure wear', type: 'delete' },
          { text: 'Daily pressure wears', type: 'insert' },
          { text: ' down my resolve.', type: 'same' },
        ],
        explanation: '表达自然。',
        betterVersion: 'Daily pressure is wearing down my resolve.',
        betterVersionKind: 'polish',
        candidate: {
          eligible: true,
          source: 'better',
          qualityScore: 0.95,
          reason: '润色版本自然且具体。',
        },
        promptMeta: { key: 'check_production', version: 2, hash: 'fake-hash', model: 'fake' },
      }),
    });
    const res = await answerOne('item-polish', 'Daily pressure wear down my resolve.', polishDeps);

    expect(res.correction).toMatchObject({ betterVersionKind: 'polish' });
    const saved = db
      .select()
      .from(learningExamples)
      .where(eq(learningExamples.kind, 'personal'))
      .get();
    expect(saved?.text).toBe('Daily pressure is wearing down my resolve.');
    const attempt = db.select().from(attempts).all()[0]!;
    expect(JSON.parse(attempt.correctionJson!)).toMatchObject({
      betterVersionKind: 'polish',
      personalExampleSource: 'better',
    });

    const taskId = db
      .select()
      .from(reviewTasks)
      .where(eq(reviewTasks.learningItemId, 'item-polish'))
      .get()!.id;
    await expect(
      undoTodayTask(db, polishDeps, TZ, new Date(NOW.getTime() + 60_000), taskId),
    ).resolves.toMatchObject({ ok: true });
    expect(
      db.select().from(learningExamples).where(eq(learningExamples.kind, 'personal')).all(),
    ).toHaveLength(0);
  });

  it('fail：降级且不插补强任务（表达题不强制当天重做）', async () => {
    await seedProductionItem('item-f', 25);
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
    expect(p.lapses).toBe(1); // fail：lapses+1

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
    await seedProductionItem('item-x', 25);
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
    expect(p.reps).toBe(4); // 未被推进
    expect(db.select().from(reviewTasks).all()[0]!.completedAt).toBeNull();
    expect(db.select().from(dailyStats).all()).toHaveLength(0);
  });

  it('幂等回放：重复提交返回首次 correction 与 personalExampleSaved，不重复写入', async () => {
    await seedProductionItem('item-r', 25);
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
    await seedProductionItem('item-v', 25);
    const d = deps();
    await startTodaySession(db, d, TZ, NOW);
    const task = db.select().from(reviewTasks).all()[0]!;
    await expect(
      answerTodayTask(db, d, TZ, NOW, task.id, { selectedOptionId: 'o1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('造句历史裁剪：第 11 条 production attempt 插入后最旧被删', async () => {
    const itemId = await seedProductionItem('item-h', 25);
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
    await seedProductionItem('item-fb', 25);
    const taskId = await answerProductionTask('item-fb');
    await expect(async () =>
      submitTaskFeedback(db, deps(), TZ, taskId, 'guessed', new Date(NOW.getTime() + 60_000)),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: '表达题不支持该反馈' });
    await expect(async () =>
      submitTaskFeedback(db, deps(), TZ, taskId, 'too_easy', new Date(NOW.getTime() + 60_000)),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('bad-question：撤销时删除本次写入的 personal example', async () => {
    await seedProductionItem('item-bq', 25);
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
    // 状态回滚 pre（reps 4 / S25）
    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'item-bq'))
      .all()
      .find((r) => r.dimension === 'production')!;
    expect(p.reps).toBe(4);
  });

  it.each([
    { answerText: 'I use item-stats well.', result: 'pass', productionPass: 1 },
    { answerText: 'An unrelated answer.', result: 'fail', productionPass: 0 },
  ])('bad-question：$result 回减表达统计且重复请求不重复扣减', async (testCase) => {
    await seedProductionItem('item-stats', 25);
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
        stability: 25,
        nextReviewAt: DUE,
      });
    }
  });

  it('bad-question：example 已被用户 pinned → 不删除', async () => {
    await seedProductionItem('item-pin', 25);
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

describe('批改中取消（断连作废，2026-10-05）', () => {
  /** 受控批改 promise：evaluateProduction 被调用后挂起，测试决定何时 resolve */
  function controlledDeps(): {
    d: TodayDeps;
    evaluated: Promise<void>;
    resolve: (v: ProductionEvaluation) => void;
  } {
    const base = deps();
    let releaseEval!: (v: ProductionEvaluation) => void;
    const gate = new Promise<ProductionEvaluation>((r) => {
      releaseEval = r;
    });
    let signalEval!: () => void;
    const evaluated = new Promise<void>((r) => {
      signalEval = r;
    });
    return {
      d: {
        ...base,
        async evaluateProduction() {
          signalEval();
          return gate;
        },
      },
      evaluated,
      resolve: releaseEval!,
    };
  }

  /** pass 形状的批改结果（与 today-fakes 的 pass 分支一致） */
  const passEvaluation = (answerText: string): ProductionEvaluation => ({
    result: 'pass',
    correctedSentence: answerText,
    segments: [{ text: answerText, type: 'same' }],
    explanation: 'fake：目标使用正确。',
    betterVersion: null,
    betterVersionKind: null,
    candidate: { eligible: true, source: 'corrected', qualityScore: 0.9, reason: 'fake' },
    promptMeta: { key: 'check_production', version: 1, hash: 'fake-hash', model: 'fake' },
  });

  async function startProductionTask(itemId: string): Promise<string> {
    await seedProductionItem(itemId, 25);
    await startTodaySession(db, deps(), TZ, NOW);
    const task = db
      .select()
      .from(reviewTasks)
      .where(eq(reviewTasks.learningItemId, itemId))
      .all()[0]!;
    return task.id;
  }

  it('断连于结算前：抛 CONFLICT「已取消」且零写入（attempts/review_states/daily_stats/任务未完成）', async () => {
    const taskId = await startProductionTask('item-cancel');
    const { d, evaluated, resolve } = controlledDeps();
    let disconnected = false;
    const answering = answerTodayTask(
      db,
      d,
      TZ,
      NOW,
      taskId,
      { answerText: 'I give item-cancel up.' },
      () => NOW,
      () => disconnected,
    );

    // 批改已发起、仍在等待窗口内 → 客户端掐断请求
    await evaluated;
    disconnected = true;
    resolve(passEvaluation('I give item-cancel up.'));

    await expect(answering).rejects.toMatchObject({ code: 'CONFLICT', message: '已取消' });
    expect(db.select().from(attempts).all()).toHaveLength(0);
    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'item-cancel'))
      .all()
      .find((r) => r.dimension === 'production')!;
    expect(p.reps).toBe(4); // FSRS 未推进（种子值）
    expect(db.select().from(reviewTasks).all()[0]!.completedAt).toBeNull();
    expect(db.select().from(dailyStats).all()).toHaveLength(0);
    // 个人例句零沉淀
    expect(db.select().from(learningExamples).all()).toHaveLength(0);
  });

  it('不断连（后台冻结连接未断）：照常结算（回归）', async () => {
    const taskId = await startProductionTask('item-frozen');
    const { d, evaluated, resolve } = controlledDeps();
    const answering = answerTodayTask(
      db,
      d,
      TZ,
      NOW,
      taskId,
      { answerText: 'I give item-frozen up.' },
      () => NOW,
      () => false, // 连接未断：iOS 后台冻结场景，isDisconnected 恒 false
    );

    await evaluated;
    resolve(passEvaluation('I give item-frozen up.'));

    const res = await answering;
    expect(res.result).toBe('pass');
    expect(db.select().from(attempts).all()).toHaveLength(1);
    expect(db.select().from(dailyStats).get()!.productionAttempts).toBe(1);
  });

  it('断连发生于结算事务后：已结算保留，重放幂等返回首次结果（取消无效）', async () => {
    const taskId = await startProductionTask('item-late');
    const { d, evaluated, resolve } = controlledDeps();
    const answering = answerTodayTask(
      db,
      d,
      TZ,
      NOW,
      taskId,
      { answerText: 'I give item-late up.' },
      () => NOW,
      () => false, // 结算时刻连接仍在
    );
    await evaluated;
    resolve(passEvaluation('I give item-late up.'));
    const first = await answering;
    expect(first.result).toBe('pass');

    // 结算落库后客户端才断（罕见竞态）：重放路径先于断连检查，返回已批结果
    const replay = await answerTodayTask(
      db,
      d,
      TZ,
      NOW,
      taskId,
      { answerText: 'whatever' },
      () => NOW,
      () => true,
    );
    expect(replay.alreadyCompleted).toBe(true);
    expect(replay.result).toBe(first.result);
    expect(replay.correction).toEqual(first.correction);
    expect(db.select().from(attempts).all()).toHaveLength(1);
  });

  it('requestDisconnected（路由接线纯函数）：socket.destroyed 为真即断连；body 读完误置的 raw.destroyed 不算断连', () => {
    expect(requestDisconnected({ socket: { destroyed: false } })).toBe(false);
    expect(requestDisconnected({})).toBe(false); // app.inject 无真 socket 的默认形态
    expect(requestDisconnected({ socket: null })).toBe(false);
    // 正常 keep-alive 请求：请求体已读完（complete），IncomingMessage 流被 Node 置
    // destroyed——这是高频误判源，绝不能作为断连信号（e2e 实测踩过）
    expect(requestDisconnected({ socket: { destroyed: false }, destroyed: true })).toBe(false);
    // 客户端 abort fetch / 关页：传输层连接销毁
    expect(requestDisconnected({ socket: { destroyed: true } })).toBe(true);
  });
});
