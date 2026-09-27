import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AnswerResponse, TodayStatusResponse } from '@el/shared';
import { loadRealTodayDeps, setTodayDepsForTests } from '../../src/modules/today/service.js';
import { createTestApp, loginCookie, type TestApp } from '../helpers/test-app.js';
import { seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';

/**
 * 真实绑定测试：review / questions 模块存在时验证 loadRealTodayDeps 适配层；
 * 并行开发期模块可能尚未交付 → skipIf 跳过（不判失败）。
 */
const realDeps = await loadRealTodayDeps().catch(() => null);

const apps: FastifyInstance[] = [];
const dayAgo = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();

afterAll(async () => {
  setTodayDepsForTests(null);
  for (const app of apps) await app.close();
});

describe.skipIf(realDeps === null)('today 与 review/questions 真实模块绑定', () => {
  let ctx: TestApp;
  let cookie: string;

  beforeAll(async () => {
    ctx = createTestApp();
    apps.push(ctx.app);
    cookie = await loginCookie(ctx.app);
    setTodayDepsForTests(realDeps);
    await seedItem(ctx.db, { id: 'rb-1', target: 'stable', queueState: 'started' });
    await seedReviewState(ctx.db, 'rb-1', 'understanding', { level: 3, nextReviewAt: dayAgo() });
    await seedQuestion(ctx.db, 'rb-1', {
      type: 'understanding',
      payloadJson: JSON.stringify({
        options: [
          { id: 'o1', text: '稳定的' },
          { id: 'o2', text: '快速的' },
        ],
      }),
      correctOptionId: 'o1',
      contextText: 'The connection is finally ____.',
      promptText: 'stable 在这里最接近什么意思？',
    });
  });

  it('start → answer 全链路走真实 review/questions service', async () => {
    const start = await ctx.app.inject({
      method: 'POST',
      url: '/api/today/start',
      headers: { cookie },
    });
    expect(start.statusCode).toBe(200);
    const started = TodayStatusResponse.parse(start.json());
    expect(started.status).toBe('active');

    const status = TodayStatusResponse.parse(
      (await ctx.app.inject({ method: 'GET', url: '/api/today', headers: { cookie } })).json(),
    );
    if (status.status !== 'active') throw new Error('应 active');
    const taskId = status.currentTask!.taskId;

    const answer = await ctx.app.inject({
      method: 'POST',
      url: `/api/today/tasks/${taskId}/answer`,
      headers: { cookie },
      payload: { recall: 'recalled' },
    });
    expect(answer.statusCode).toBe(200);
    const body = AnswerResponse.parse(answer.json());
    expect(body.result).toBe('pass');
    expect(body.outcomeSource).toBe('recalled');
    expect(body.correct).toBe(true);
    // 真实 review 状态机应推进了等级（L3 → L4）
    const { reviewStates } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const state = ctx.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'rb-1'))
      .get();
    expect(state?.level).toBeGreaterThan(3);
    expect(state?.nextReviewAt).not.toBeNull();
  });
});
