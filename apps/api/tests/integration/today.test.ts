import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  AnswerResponse,
  LaterResponse,
  TaskFeedbackResponse,
  TodaySessionTasksResponse,
  TodayStatusResponse,
  UndoResponse,
} from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import {
  attempts,
  dailyStats,
  learningExamples,
  learningItems,
  reviewStates,
  reviewTasks,
} from '../../src/db/schema.js';
import { setTodayDepsForTests, type TodayDeps } from '../../src/modules/today/service.js';
import { createTestApp, loginCookie, type TestApp } from '../helpers/test-app.js';
import { seedExample, seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';
import { choicePayload, createFakeDeps, DEFAULT_OPTIONS } from '../helpers/today-fakes.js';

const apps: FastifyInstance[] = [];
const dayAgo = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();

interface Ctx extends TestApp {
  cookie: string;
}

async function newCtx(seed: (db: AppDatabase) => Promise<void>): Promise<Ctx> {
  const ctx = createTestApp();
  apps.push(ctx.app);
  const cookie = await loginCookie(ctx.app);
  setTodayDepsForTests(createFakeDeps());
  await seed(ctx.db);
  return { ...ctx, cookie };
}

async function get(ctx: Ctx, url: string) {
  return ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.cookie } });
}

async function post(ctx: Ctx, url: string, payload?: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url, headers: { cookie: ctx.cookie }, payload });
}

async function seedDueChoice(db: AppDatabase, itemId: string, target: string): Promise<void> {
  await seedItem(db, { id: itemId, target, queueState: 'started' });
  await seedReviewState(db, itemId, 'understanding', { level: 3, nextReviewAt: dayAgo() });
  await seedQuestion(db, itemId, {
    type: 'understanding',
    payloadJson: choicePayload(DEFAULT_OPTIONS, '解释'),
    correctOptionId: 'o1',
    contextText: `A ____ ${target} sentence.`,
    promptText: `${target} 在这里最接近什么意思？`,
  });
  await seedExample(db, itemId, 'source', `Source example of ${target}.`);
}

async function seedDueCloze(db: AppDatabase, itemId: string, target: string): Promise<void> {
  await seedItem(db, { id: itemId, target, queueState: 'started' });
  await seedReviewState(db, itemId, 'production', { level: 1, nextReviewAt: dayAgo() });
  await seedQuestion(db, itemId, {
    type: 'cloze',
    payloadJson: JSON.stringify({ acceptedAnswers: [target], explanation: 'cloze 解释' }),
    contextText: `Use the ____ ${target} here.`,
  });
}

async function seedDueProduction(db: AppDatabase, itemId: string, target: string): Promise<void> {
  await seedItem(db, { id: itemId, target, queueState: 'started' });
  await seedReviewState(db, itemId, 'production', { level: 4, nextReviewAt: dayAgo() });
  await seedQuestion(db, itemId, {
    type: 'production',
    promptText: `请使用 ${target} 表达这个意思。`,
    payloadJson: JSON.stringify({
      mustUse: target,
      referenceAnswer: `They ${target} naturally.`,
      acceptanceNotes: '允许正常时态变化。',
    }),
    correctOptionId: null,
  });
}

afterAll(async () => {
  setTodayDepsForTests(null);
  for (const app of apps) await app.close();
});

describe('GET /api/today 契约（三态）', () => {
  it('未登录返回 401', async () => {
    const ctx = await newCtx(async () => {});
    const res = await ctx.app.inject({ method: 'GET', url: '/api/today' });
    expect(res.statusCode).toBe(401);
  });

  it('idle 响应符合冻结契约 schema', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'it-1', 'stable');
      await seedDueCloze(db, 'it-2', 'raw');
      for (let i = 0; i < 12; i++) {
        await seedItem(db, {
          id: `nw-${i}`,
          target: `new-word-${i}`,
          queueState: 'new',
          createdAt: `2026-09-01T00:00:0${i % 10}.000Z`,
        });
      }
    });
    const res = await get(ctx, '/api/today');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(TodayStatusResponse.safeParse(body).success).toBe(true);
    expect(body.status).toBe('idle');
    expect(body.dueItems).toBe(2);
    expect(body.newTodayAvailable).toBe(10);
    expect(body.totalItems).toBe(14); // 2 started + 12 new（active）
    expect(body.newQueueCount).toBe(12);
    // 无 Learn 历史时回退为最近创建的 started 项
    expect(body.recentlyLearned.map((x: { id: string }) => x.id).sort()).toEqual(['it-1', 'it-2']);
  });

  it('start 返回 active 并符合契约；重复 start 幂等返回同一 session', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'it-1', 'stable');
    });
    const first = await post(ctx, '/api/today/start');
    expect(first.statusCode).toBe(200);
    expect(TodayStatusResponse.safeParse(first.json()).success).toBe(true);
    expect(first.json().status).toBe('active');

    const second = await post(ctx, '/api/today/start');
    expect(second.json().status).toBe('active');
    expect(second.json().session.id).toBe(first.json().session.id);
  });

  it('active 的 currentTask：选择题视图不泄漏正确答案；理解题携带 sourceExample（前端按需展示）', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'it-1', 'stable');
    });
    await post(ctx, '/api/today/start');
    const res = await get(ctx, '/api/today');
    const active = TodayStatusResponse.parse(res.json());
    if (active.status !== 'active') throw new Error('应 active');
    expect(active.progress).toEqual({ completed: 0, total: 1 });
    const task = active.currentTask!;
    expect(task.item.target).toBe('stable');
    expect(task.sourceExample).toBe('Source example of stable.');
    const q = task.question;
    if (q && 'options' in q) {
      expect(q.options).toHaveLength(4);
      expect(JSON.stringify(q)).not.toContain('correctOptionId');
    }
  });
});

describe('POST /api/today/tasks/:id/answer 契约', () => {
  it('作答 → AnswerResponse 契约；重复提交 alreadyCompleted；全部完成 → completed 摘要', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'it-1', 'stable');
      await seedDueCloze(db, 'it-2', 'raw');
    });
    await post(ctx, '/api/today/start');

    // 依次作答全部任务
    const answeredIds: string[] = [];
    const results: string[] = [];
    for (;;) {
      const status = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
      if (status.status !== 'active' || status.currentTask === null) break;
      const task = status.currentTask;
      const isChoice = task.question !== null && 'options' in task.question;
      // understanding 复习任务走 Recall 直判；learn 首题/填空题维持旧提交形态
      const payload =
        task.taskType === 'understanding'
          ? { recall: 'recalled' }
          : isChoice
            ? { selectedOptionId: 'o1' }
            : { answerText: 'raw' };
      const res = await post(ctx, `/api/today/tasks/${task.taskId}/answer`, payload);
      expect(res.statusCode).toBe(200);
      const parsed = AnswerResponse.parse(res.json());
      expect(parsed.alreadyCompleted).toBeUndefined();
      expect(parsed.progress.completed).toBe(answeredIds.length + 1);
      answeredIds.push(task.taskId);
      results.push(parsed.result);
    }
    expect(answeredIds).toHaveLength(2);
    expect(results).toEqual(['pass', 'pass']);

    // 幂等重复提交
    const replay = await post(ctx, `/api/today/tasks/${answeredIds[0]}/answer`, {
      selectedOptionId: 'o2',
    });
    expect(replay.statusCode).toBe(200);
    const replayBody = AnswerResponse.parse(replay.json());
    expect(replayBody.alreadyCompleted).toBe(true);
    expect(replayBody.result).toBe('pass');
    expect(replayBody.outcomeSource).toBe('recalled');
    expect(replayBody.completed?.totalTasks).toBe(2);

    // 会话完成态
    const done = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
    if (done.status !== 'completed') throw new Error('应 completed');
    expect(done.summary).toEqual({
      totalTasks: 2,
      pass: 2,
      basicPass: 0,
      fail: 0,
      newItemsStarted: 0,
      recommendRead: false,
    });
  });

  it('fail 后补强加入队列，答完补强才完成；recommendRead=true', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'it-1', 'stable');
    });
    await post(ctx, '/api/today/start');
    const status1 = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
    const taskId = status1.status === 'active' ? status1.currentTask!.taskId : '';

    const fail = await post(ctx, `/api/today/tasks/${taskId}/answer`, {
      selectedOptionId: 'o2',
    });
    const failBody = AnswerResponse.parse(fail.json());
    expect(failBody.result).toBe('fail');
    expect(failBody.outcomeSource).toBe('forgot');
    expect(failBody.reinforcementAdded).toBe(true);
    expect(failBody.explanation).toBe('解释');
    expect(failBody.correctOptionId).toBe('o1');
    expect(failBody.completed).toBeNull(); // 补强未清空

    const status2 = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
    if (status2.status !== 'active') throw new Error('应 active');
    expect(status2.progress).toEqual({ completed: 1, total: 2 });

    const rf = await post(ctx, `/api/today/tasks/${status2.currentTask!.taskId}/answer`, {
      selectedOptionId: 'g1', // fake generate 产题的正确项
    });
    const rfBody = AnswerResponse.parse(rf.json());
    expect(rfBody.result).toBe('basic_pass'); // 提交选项 = hint 语义 → basic_pass
    expect(rfBody.outcomeSource).toBe('assisted');
    expect(rfBody.completed).not.toBeNull();
    expect(rfBody.completed?.recommendRead).toBe(true);
  });

  it('请求体校验失败 → 400 VALIDATION_ERROR；未知任务 → 404', async () => {
    const ctx = await newCtx(async () => {});
    const bad = await post(ctx, '/api/today/tasks/x/answer', { selectedOptionId: '' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');

    const missing = await post(ctx, '/api/today/tasks/no-such/answer', {
      selectedOptionId: 'o1',
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /api/today/tasks/:id/answer 主动不会（giveUp）', () => {
  /** 统计判定调用次数的 fake deps（验证 give-up 零判定/零批改） */
  function countingDeps(): {
    deps: TodayDeps;
    calls: { choice: number; cloze: number; production: number };
  } {
    const base = createFakeDeps();
    const calls = { choice: 0, cloze: 0, production: 0 };
    const deps: TodayDeps = {
      ...base,
      evaluateChoice: (question, selectedOptionId) => {
        calls.choice += 1;
        return base.evaluateChoice(question, selectedOptionId);
      },
      evaluateCloze: async (db, question, answerText) => {
        calls.cloze += 1;
        return base.evaluateCloze(db, question, answerText);
      },
      evaluateProduction: async (db, question, answerText) => {
        calls.production += 1;
        return base.evaluateProduction(db, question, answerText);
      },
    };
    return { deps, calls };
  }

  function taskIdOf(ctx: Ctx, itemId: string): string {
    const task = ctx.db
      .select()
      .from(reviewTasks)
      .all()
      .find((t) => t.learningItemId === itemId);
    if (!task) throw new Error(`找不到 ${itemId} 的任务`);
    return task.id;
  }

  function attemptOf(ctx: Ctx, taskId: string) {
    const attempt = ctx.db.select().from(attempts).where(eq(attempts.reviewTaskId, taskId)).get();
    if (!attempt) throw new Error('应写入 attempt');
    return attempt;
  }

  it('give up reveals correct choice and reason', async () => {
    const { deps, calls } = countingDeps();
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'gu-1', 'stable');
    });
    setTodayDepsForTests(deps);
    await post(ctx, '/api/today/start');
    const taskId = taskIdOf(ctx, 'gu-1');

    const res = await post(ctx, `/api/today/tasks/${taskId}/answer`, { giveUp: true });
    expect(res.statusCode).toBe(200);
    const body = AnswerResponse.parse(res.json());
    // 直接按 fail 结算（不判定、不伪造答案）
    expect(body.result).toBe('fail');
    expect(body.correct).toBe(false);
    expect(body.gaveUp).toBe(true);
    expect(body.outcomeSource).toBe('forgot');
    // 选择题揭示：正确选项 + 理由
    expect(body.correctOptionId).toBe('o1');
    expect(body.explanation).toBe('解释');
    // give-up 不携带提交答案，也不泄漏表达题参考字段
    expect(body.selectedOptionId ?? null).toBeNull();
    expect(body.submittedAnswerText ?? null).toBeNull();
    expect(body.referenceAnswer ?? null).toBeNull();
    expect(body.answerNote ?? null).toBeNull();
    expect(body.correction).toBeNull();
    // 既有 fail 结算规则不变：补强照插、维度降级 L3 → L2
    expect(body.reinforcementAdded).toBe(true);
    const state = ctx.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'gu-1'))
      .get();
    expect(state?.level).toBe(2);

    // attempt：feedback=gave_up、无提交答案、零 AI 追溯字段
    const attempt = attemptOf(ctx, taskId);
    expect(attempt.feedback).toBe('gave_up');
    expect(attempt.result).toBe('fail');
    expect(attempt.answerText).toBeNull();
    expect(attempt.selectedOptionId).toBeNull();
    expect(attempt.correctionJson).toBeNull();
    expect(attempt.aiPromptKey).toBeNull();

    // 零判定调用（选择题/填空/生产批改均未触发）
    expect(calls).toEqual({ choice: 0, cloze: 0, production: 0 });
  });

  it('give up reveals complete cloze and accepted answer', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueCloze(db, 'gu-2', 'raw');
    });
    await post(ctx, '/api/today/start');
    const taskId = taskIdOf(ctx, 'gu-2');

    const res = await post(ctx, `/api/today/tasks/${taskId}/answer`, { giveUp: true });
    expect(res.statusCode).toBe(200);
    const body = AnswerResponse.parse(res.json());
    expect(body.result).toBe('fail');
    expect(body.correct).toBe(false);
    expect(body.gaveUp).toBe(true);
    // 填空揭示：完整句 + 可接受答案 + 解释
    expect(body.completeSentence).toBe('Use the raw raw here.');
    expect(body.acceptedAnswer).toBe('raw');
    expect(body.explanation).toBe('cloze 解释');
    expect(body.correctOptionId ?? null).toBeNull();
    expect(body.submittedAnswerText ?? null).toBeNull();
    expect(body.referenceAnswer ?? null).toBeNull();
    // 既有 fail 结算：填空 fail 插补强
    expect(body.reinforcementAdded).toBe(true);

    const attempt = attemptOf(ctx, taskId);
    expect(attempt.feedback).toBe('gave_up');
    expect(attempt.result).toBe('fail');
    expect(attempt.answerText).toBeNull();
  });

  it('give up reveals production reference without AI grading', async () => {
    const { deps, calls } = countingDeps();
    const ctx = await newCtx(async (db) => {
      await seedDueProduction(db, 'gu-3', 'wear down');
    });
    setTodayDepsForTests(deps);
    await post(ctx, '/api/today/start');
    const taskId = taskIdOf(ctx, 'gu-3');

    const res = await post(ctx, `/api/today/tasks/${taskId}/answer`, { giveUp: true });
    expect(res.statusCode).toBe(200);
    const body = AnswerResponse.parse(res.json());
    expect(body.result).toBe('fail');
    expect(body.correct).toBe(false);
    expect(body.gaveUp).toBe(true);
    // 参考句与目标用法说明来自绑定题目 payload；不伪造批改 diff
    expect(body.referenceAnswer).toBe('They wear down naturally.');
    expect(body.answerNote).toBe('允许正常时态变化。');
    expect(body.correction).toBeNull();
    expect(body.explanation ?? null).toBeNull();
    expect(body.submittedAnswerText ?? null).toBeNull();
    // 表达题 fail 不强制当天补强；唯一任务结算 → 会话完成摘要
    expect(body.reinforcementAdded).toBe(false);
    expect(body.completed).toMatchObject({ totalTasks: 1, fail: 1, recommendRead: true });

    const attempt = attemptOf(ctx, taskId);
    expect(attempt.feedback).toBe('gave_up');
    expect(attempt.answerText).toBeNull();
    expect(attempt.correctionJson).toBeNull();
    expect(attempt.aiPromptKey).toBeNull();

    // 统计沿用既有 fail 结算：计作答数、不计通过；未写句子不沉淀 Personal Example
    expect(ctx.db.select().from(dailyStats).get()).toMatchObject({
      formalTasksCompleted: 1,
      productionAttempts: 1,
      productionPass: 0,
    });
    expect(
      ctx.db
        .select()
        .from(learningExamples)
        .all()
        .filter((e) => e.kind === 'personal'),
    ).toHaveLength(0);

    // 零生产批改调用；重复提交（换 payload 也一样）回放首次揭示
    expect(calls.production).toBe(0);
    const replay = await post(ctx, `/api/today/tasks/${taskId}/answer`, {
      answerText: 'late answer',
    });
    expect(replay.statusCode).toBe(200);
    const replayBody = AnswerResponse.parse(replay.json());
    expect(replayBody.alreadyCompleted).toBe(true);
    expect(replayBody.gaveUp).toBe(true);
    expect(replayBody.result).toBe('fail');
    expect(replayBody.referenceAnswer).toBe('They wear down naturally.');
    expect(replayBody.answerNote).toBe('允许正常时态变化。');
    expect(replayBody.correction).toBeNull();
    expect(replayBody.submittedAnswerText ?? null).toBeNull();
    expect(calls.production).toBe(0);
  });

  it('unsubmitted task hides answers', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'hd-1', 'stable');
      await seedDueCloze(db, 'hd-2', 'quartz');
      await seedDueProduction(db, 'hd-3', 'wear down');
    });
    await post(ctx, '/api/today/start');

    // GET /api/today 当前任务视图：无正确选项/参考句/可接受答案
    const status = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
    if (status.status !== 'active' || status.currentTask === null) throw new Error('应 active');
    const current = JSON.stringify(status.currentTask);
    expect(current).not.toContain('correctOptionId');
    expect(current).not.toContain('referenceAnswer');
    expect(current).not.toContain('They wear down naturally.');
    expect(current).not.toContain('acceptedAnswers');

    // GET /api/today/tasks：未作答任务 result=null，题面视图同样不含答案
    const listed = await get(ctx, '/api/today/tasks');
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { tasks: Array<{ result: unknown; task: unknown }> };
    expect(body.tasks).toHaveLength(3);
    for (const entry of body.tasks) {
      expect(entry.result).toBeNull();
      const view = JSON.stringify(entry.task);
      expect(view).not.toContain('correctOptionId');
      expect(view).not.toContain('referenceAnswer');
      expect(view).not.toContain('They wear down naturally.');
      expect(view).not.toContain('acceptedAnswers');
    }
  });

  it('replay preserves give-up and submitted answer', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'rp-1', 'stable');
      await seedDueProduction(db, 'rp-2', 'wear down');
    });
    await post(ctx, '/api/today/start');
    const giveUpId = taskIdOf(ctx, 'rp-1');
    const prodId = taskIdOf(ctx, 'rp-2');

    const giveUpRes = AnswerResponse.parse(
      (await post(ctx, `/api/today/tasks/${giveUpId}/answer`, { giveUp: true })).json(),
    );
    const genuineRes = AnswerResponse.parse(
      (
        await post(ctx, `/api/today/tasks/${prodId}/answer`, { answerText: 'I wear down easily.' })
      ).json(),
    );
    // 真实作答：新字段携带已提交内容，不携带 give-up 揭示
    expect(genuineRes.gaveUp).toBe(false);
    expect(genuineRes.submittedAnswerText).toBe('I wear down easily.');
    expect(genuineRes.selectedOptionId ?? null).toBeNull();
    expect(genuineRes.referenceAnswer ?? null).toBeNull();
    expect(genuineRes.answerNote ?? null).toBeNull();

    // 首次结算与回放的揭示/提交字段完全一致
    const revealFields = (r: Record<string, unknown>) => ({
      result: r.result,
      outcomeSource: r.outcomeSource ?? null,
      correct: r.correct,
      gaveUp: r.gaveUp ?? false,
      selectedOptionId: r.selectedOptionId ?? null,
      submittedAnswerText: r.submittedAnswerText ?? null,
      referenceAnswer: r.referenceAnswer ?? null,
      answerNote: r.answerNote ?? null,
      explanation: r.explanation ?? null,
      correctOptionId: r.correctOptionId ?? null,
      completeSentence: r.completeSentence ?? null,
      acceptedAnswer: r.acceptedAnswer ?? null,
      correction: r.correction ?? null,
      personalExampleSaved: r.personalExampleSaved ?? false,
    });

    const listed = await get(ctx, '/api/today/tasks');
    const entries = (
      listed.json() as { tasks: Array<{ task: { taskId: string }; result: unknown }> }
    ).tasks;
    const replayedGiveUp = AnswerResponse.parse(
      entries.find((e) => e.task.taskId === giveUpId)!.result as object,
    );
    expect(replayedGiveUp.alreadyCompleted).toBe(true);
    expect(revealFields(replayedGiveUp as unknown as Record<string, unknown>)).toEqual(
      revealFields(giveUpRes as unknown as Record<string, unknown>),
    );

    const replayedGenuine = AnswerResponse.parse(
      entries.find((e) => e.task.taskId === prodId)!.result as object,
    );
    expect(replayedGenuine.alreadyCompleted).toBe(true);
    expect(revealFields(replayedGenuine as unknown as Record<string, unknown>)).toEqual(
      revealFields(genuineRes as unknown as Record<string, unknown>),
    );

    // 幂等重复提交走同一回放路径，字段仍一致
    const again = AnswerResponse.parse(
      (await post(ctx, `/api/today/tasks/${giveUpId}/answer`, { giveUp: true })).json(),
    );
    expect(again.alreadyCompleted).toBe(true);
    expect(revealFields(again as unknown as Record<string, unknown>)).toEqual(
      revealFields(giveUpRes as unknown as Record<string, unknown>),
    );
  });

  it('giveUp 与作答内容互斥 → 400；缺答案且无 giveUp → 400 且零写入', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'vd-1', 'stable');
      await seedDueCloze(db, 'vd-2', 'raw');
    });
    await post(ctx, '/api/today/start');
    const choiceId = taskIdOf(ctx, 'vd-1');
    const clozeId = taskIdOf(ctx, 'vd-2');

    // giveUp 与 option/text/recall/hint 互斥
    for (const payload of [
      { giveUp: true, selectedOptionId: 'o1' },
      { giveUp: true, answerText: 'raw' },
      { giveUp: true, recall: 'recalled' },
      { giveUp: true, hintUsed: true },
    ]) {
      const res = await post(ctx, `/api/today/tasks/${choiceId}/answer`, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }

    // 缺答案且无 giveUp → 400（giveUp=false 同样无效：契约要求 giveUp?: true）
    for (const [taskId, payload] of [
      [choiceId, {}],
      [choiceId, { viewedSource: true }],
      [choiceId, { giveUp: false }],
      [clozeId, { selectedOptionId: 'o1' }],
    ] as const) {
      const res = await post(ctx, `/api/today/tasks/${taskId}/answer`, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }

    // 以上全部被拒绝：无 attempt、无任务结算
    expect(ctx.db.select().from(attempts).all()).toHaveLength(0);
    expect(
      ctx.db
        .select()
        .from(reviewTasks)
        .all()
        .every((t) => t.completedAt === null),
    ).toBe(true);
  });
});

describe('POST /api/today/tasks/:id/undo 契约', () => {
  it('undo：ok+progress 契约、未作答 409、未知任务 404、重复撤销 409', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'ud-1', 'wear down');
      await seedQuestion(db, 'ud-1', {
        id: 'ud-1-q2',
        type: 'understanding',
        payloadJson: choicePayload(DEFAULT_OPTIONS, '解释'),
        correctOptionId: 'o1',
        contextText: 'Another ____ sentence.',
      });
    });
    await post(ctx, '/api/today/start');
    const status = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
    const taskId = status.status === 'active' ? status.currentTask!.taskId : '';

    // 未作答不能撤销
    const early = await post(ctx, `/api/today/tasks/${taskId}/undo`);
    expect(early.statusCode).toBe(409);

    const answer = await post(ctx, `/api/today/tasks/${taskId}/answer`, { recall: 'recalled' });
    expect(answer.statusCode).toBe(200);

    const undo = await post(ctx, `/api/today/tasks/${taskId}/undo`);
    expect(undo.statusCode).toBe(200);
    expect(UndoResponse.safeParse(undo.json()).success).toBe(true);
    expect(undo.json().progress).toEqual({ completed: 0, total: 1 });

    // 重复撤销（任务已取消）→ 409；替代任务成为新的当前题
    const again = await post(ctx, `/api/today/tasks/${taskId}/undo`);
    expect(again.statusCode).toBe(409);
    const next = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
    if (next.status !== 'active') throw new Error('撤销后会话应重新激活');
    expect(next.currentTask!.taskId).not.toBe(taskId);

    const missing = await post(ctx, '/api/today/tasks/no-such/undo');
    expect(missing.statusCode).toBe(404);
  });

  it('undoableTaskId 只指向最近一次有效作答；撤销后回退到上一题', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'ut-1', 'wear down');
      await seedQuestion(db, 'ut-1', {
        id: 'ut-1-q2',
        type: 'understanding',
        payloadJson: choicePayload(DEFAULT_OPTIONS, '解释'),
        correctOptionId: 'o1',
        contextText: 'Another ____ sentence.',
      });
      await seedDueChoice(db, 'ut-2', 'make sense');
      await seedQuestion(db, 'ut-2', {
        id: 'ut-2-q2',
        type: 'understanding',
        payloadJson: choicePayload(DEFAULT_OPTIONS, '解释'),
        correctOptionId: 'o1',
        contextText: 'Another ____ sentence.',
      });
    });
    await post(ctx, '/api/today/start');

    const listedIds = async () => {
      const res = await get(ctx, '/api/today/tasks');
      expect(res.statusCode).toBe(200);
      const body = TodaySessionTasksResponse.parse(res.json());
      return body.undoableTaskId;
    };

    expect(await listedIds()).toBeNull(); // 无作答 → 无可撤销

    const status1 = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
    const firstId = status1.status === 'active' ? status1.currentTask!.taskId : '';
    await post(ctx, `/api/today/tasks/${firstId}/answer`, { recall: 'recalled' });
    expect(await listedIds()).toBe(firstId); // 最近一次作答

    // 答完剩余任务（含补强/第二题），undoableTaskId 跟随最新一次作答
    for (;;) {
      const status = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
      if (status.status !== 'active' || status.currentTask === null) break;
      const task = status.currentTask;
      await post(ctx, `/api/today/tasks/${task.taskId}/answer`, { recall: 'recalled' });
      const undone = await listedIds();
      expect(undone).not.toBeNull();
      const tasksRes = TodaySessionTasksResponse.parse((await get(ctx, '/api/today/tasks')).json());
      expect(tasksRes.tasks.map((e) => e.task.taskId)).toContain(undone);
    }

    // 撤销最近一次 → 回退到上一个仍有有效作答的任务
    const before = TodaySessionTasksResponse.parse((await get(ctx, '/api/today/tasks')).json());
    const lastId = before.undoableTaskId!;
    const undo = await post(ctx, `/api/today/tasks/${lastId}/undo`);
    expect(undo.statusCode).toBe(200);
    expect(await listedIds()).not.toBe(lastId);
    // 被撤销任务不再作为可撤销目标，也不回放结果
    const after = TodaySessionTasksResponse.parse((await get(ctx, '/api/today/tasks')).json());
    const entry = after.tasks.find((e) => e.task.taskId === lastId)!;
    expect(entry.canceled).toBe(true);
    expect(entry.result).toBeNull();
  });
});

describe('later / bad-question / feedback HTTP 契约', () => {
  it('later：ok+progress、未知任务 404、已完成任务 409', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'lt-1', 'wear down');
      await seedDueChoice(db, 'lt-2', 'make sense');
    });
    await post(ctx, '/api/today/start');

    const missing = await post(ctx, '/api/today/tasks/no-such-task/later');
    expect(missing.statusCode).toBe(404);

    const status = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
    const taskId = status.status === 'active' ? status.currentTask!.taskId : '';
    const later = await post(ctx, `/api/today/tasks/${taskId}/later`);
    expect(later.statusCode).toBe(200);
    expect(LaterResponse.safeParse(later.json()).success).toBe(true);
    expect(later.json().progress).toEqual({ completed: 0, total: 2 });

    // 作答另一个任务后，对已完成任务 later → 409
    const status2 = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
    const next = status2.status === 'active' ? status2.currentTask!.taskId : '';
    const answer = await post(ctx, `/api/today/tasks/${next}/answer`, { selectedOptionId: 'o1' });
    expect(answer.statusCode).toBe(200);
    const laterDone = await post(ctx, `/api/today/tasks/${next}/later`);
    expect(laterDone.statusCode).toBe(409);
  });

  it('bad-question：撤销 Learn 激活、queue 回 new、幂等', async () => {
    const ctx = await newCtx(async (db) => {
      await seedItem(db, {
        id: 'bq-1',
        target: 'gravity',
        queueState: 'new',
        createdAt: '2026-09-01T00:00:00.000Z',
      });
      await seedQuestion(db, 'bq-1', {
        type: 'understanding',
        payloadJson: choicePayload(DEFAULT_OPTIONS),
        correctOptionId: 'o1',
      });
    });
    await post(ctx, '/api/today/start');
    const status = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
    const taskId = status.status === 'active' ? status.currentTask!.taskId : '';

    const answer = await post(ctx, `/api/today/tasks/${taskId}/answer`, {
      selectedOptionId: 'o1',
    });
    expect(answer.statusCode).toBe(200);

    const bad = await post(ctx, `/api/today/tasks/${taskId}/bad-question`);
    expect(bad.statusCode).toBe(200);
    expect(bad.json().ok).toBe(true);
    expect(bad.json().progress).toEqual({ completed: 0, total: 0 });

    expect(
      ctx.db.select().from(learningItems).where(eq(learningItems.id, 'bq-1')).get()?.queueState,
    ).toBe('new');
    expect(ctx.db.select().from(reviewStates).all()).toHaveLength(0);

    const again = await post(ctx, `/api/today/tasks/${taskId}/bad-question`);
    expect(again.statusCode).toBe(200);
    expect(again.json().ok).toBe(true);
  });

  it('feedback：guessed 返回 adjustedResult=fail；learn 任务 409', async () => {
    const ctx = await newCtx(async (db) => {
      await seedDueChoice(db, 'fb-1', 'stable');
      await seedItem(db, {
        id: 'fb-new',
        target: 'gravity',
        queueState: 'new',
        createdAt: '2026-09-01T00:00:00.000Z',
      });
      await seedQuestion(db, 'fb-new', {
        type: 'understanding',
        payloadJson: choicePayload(DEFAULT_OPTIONS),
        correctOptionId: 'o1',
      });
    });
    await post(ctx, '/api/today/start');

    // 找到 understanding 任务并答对
    let targetTaskId = '';
    for (;;) {
      const status = TodayStatusResponse.parse((await get(ctx, '/api/today')).json());
      if (status.status !== 'active' || status.currentTask === null) break;
      const task = status.currentTask;
      const isChoice = task.question !== null && 'options' in task.question;
      const res = await post(ctx, `/api/today/tasks/${task.taskId}/answer`, {
        ...(isChoice ? { selectedOptionId: 'o1' } : { answerText: 'gravity' }),
      });
      expect(res.statusCode).toBe(200);
      if (task.taskType === 'understanding') targetTaskId = task.taskId;
    }

    const fb = await post(ctx, `/api/today/tasks/${targetTaskId}/feedback`, {
      feedback: 'guessed',
    });
    expect(fb.statusCode).toBe(200);
    expect(TaskFeedbackResponse.safeParse(fb.json()).success).toBe(true);
    expect(fb.json().adjustedResult).toBe('fail');

    const dup = await post(ctx, `/api/today/tasks/${targetTaskId}/feedback`, {
      feedback: 'too_easy',
    });
    expect(dup.statusCode).toBe(409);

    // learn 任务反馈 → 409
    const learnTask = ctx.db
      .select()
      .from(reviewTasks)
      .all()
      .find((t) => t.taskType === 'learn');
    if (learnTask) {
      const res = await post(ctx, `/api/today/tasks/${learnTask.id}/feedback`, {
        feedback: 'too_easy',
      });
      expect(res.statusCode).toBe(409);
    }
  });
});
