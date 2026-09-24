import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  AnswerResponse,
  LaterResponse,
  TaskFeedbackResponse,
  TodayStatusResponse,
} from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import { learningItems, reviewStates, reviewTasks } from '../../src/db/schema.js';
import { setTodayDepsForTests } from '../../src/modules/today/service.js';
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
      const res = await post(ctx, `/api/today/tasks/${task.taskId}/answer`, {
        ...(isChoice ? { selectedOptionId: 'o1' } : { answerText: 'raw' }),
      });
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
