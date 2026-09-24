import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { PracticeAnswerResponse, PracticeStartResponse } from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import {
  attempts,
  dailyStats,
  learningExamples,
  learningItems,
  questions,
  reviewStates,
} from '../../src/db/schema.js';
import { setPracticeDepsForTests, type PracticeDeps } from '../../src/modules/practice/service.js';
import { createTestApp, loginCookie, type TestApp } from '../helpers/test-app';
import { seedExample, seedItem, seedQuestion, seedReviewState } from '../helpers/seed';
import { choicePayload, createFakeDeps, DEFAULT_OPTIONS } from '../helpers/today-fakes';

const apps: FastifyInstance[] = [];
const dayAgo = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();

interface Ctx extends TestApp {
  cookie: string;
}

async function newCtx(seed: (db: AppDatabase) => Promise<void>): Promise<Ctx> {
  const ctx = createTestApp();
  apps.push(ctx.app);
  const cookie = await loginCookie(ctx.app);
  setPracticeDepsForTests(practiceFakes());
  await seed(ctx.db);
  return { ...ctx, cookie };
}

/** 从 today fake 复用 acquire/generate/evaluate*，组合成 PracticeDeps */
function practiceFakes(): PracticeDeps {
  const f = createFakeDeps();
  return {
    acquire: f.acquire,
    generate: f.generate,
    evaluateChoice: f.evaluateChoice,
    evaluateCloze: f.evaluateCloze,
    evaluateProduction: f.evaluateProduction,
  };
}

async function post(ctx: Ctx, url: string, payload?: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url, headers: { cookie: ctx.cookie }, payload });
}

const PROD_PAYLOAD = JSON.stringify({
  mustUse: 'stable',
  referenceAnswer: 'The connection is stable.',
  acceptanceNotes: '允许变化。',
});

async function seedWithP(db: AppDatabase, itemId: string, pLevel: number | null): Promise<void> {
  await seedItem(db, { id: itemId, target: 'stable', queueState: 'started' });
  await seedExample(db, itemId, 'source', 'The connection has been stable all week.');
  if (pLevel !== null) {
    await seedReviewState(db, itemId, 'production', { level: pLevel, nextReviewAt: dayAgo() });
  }
  await seedQuestion(db, itemId, {
    type: 'understanding',
    payloadJson: choicePayload(DEFAULT_OPTIONS, '理解解释'),
    correctOptionId: 'o1',
    contextText: 'A ____ sentence.',
    promptText: 'stable 最接近什么意思？',
  });
  await seedQuestion(db, itemId, {
    type: 'cloze',
    payloadJson: JSON.stringify({ acceptedAnswers: ['stable'], explanation: 'cloze 解释' }),
    promptText: 'The connection is ____.',
    correctOptionId: null,
  });
  await seedQuestion(db, itemId, {
    type: 'production',
    promptText: '请使用 stable 描述一个稳定的连接。',
    payloadJson: PROD_PAYLOAD,
    correctOptionId: null,
  });
}

afterAll(async () => {
  setPracticeDepsForTests(null);
  for (const app of apps) await app.close();
});

describe('POST /api/library/:id/practice（start）', () => {
  it('无 P 状态 → 2 选择 + 1 填空；响应符合冻结契约', async () => {
    const ctx = await newCtx(async (db) => {
      await seedWithP(db, 'pr-1', null);
    });
    const res = await post(ctx, '/api/library/pr-1/practice');
    expect(res.statusCode).toBe(200);
    const body = PracticeStartResponse.parse(res.json());
    expect(body.questions).toHaveLength(3);
    const counts = {
      choice: body.questions.filter((q) => q.qtype === 'choice').length,
      cloze: body.questions.filter((q) => q.qtype === 'cloze').length,
      production: body.questions.filter((q) => q.qtype === 'production').length,
    };
    expect(counts).toEqual({ choice: 2, cloze: 1, production: 0 });
  });

  it('P-L4 → 1 选择 + 2 表达题；production 视图不含 reference', async () => {
    const ctx = await newCtx(async (db) => {
      await seedWithP(db, 'pr-2', 4);
    });
    const res = await post(ctx, '/api/library/pr-2/practice');
    expect(res.statusCode).toBe(200);
    const body = PracticeStartResponse.parse(res.json());
    expect(body.questions).toHaveLength(3);
    const counts = {
      choice: body.questions.filter((q) => q.qtype === 'choice').length,
      production: body.questions.filter((q) => q.qtype === 'production').length,
    };
    expect(counts).toEqual({ choice: 1, production: 2 });
    const prod = body.questions.find((q) => q.qtype === 'production')!;
    if (prod.qtype !== 'production') throw new Error('unreachable');
    expect(prod.zhPrompt).toBe('请使用 stable 描述一个稳定的连接。');
    expect(prod.mustUse).toBe('stable');
    expect(JSON.stringify(body.questions)).not.toContain('The connection is stable.');
  });

  it('P-L1 → 1 选择 + 2 填空（early 阶段填空为主）', async () => {
    const ctx = await newCtx(async (db) => {
      await seedWithP(db, 'pr-3', 1);
    });
    const body = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-3/practice')).json(),
    );
    expect(body.questions.filter((q) => q.qtype === 'choice')).toHaveLength(1);
    expect(body.questions.filter((q) => q.qtype === 'cloze')).toHaveLength(2);
  });

  it('优先从库存取：返回已种子的题（id 来自库存），不依赖生成', async () => {
    const ctx = await newCtx(async (db) => {
      await seedWithP(db, 'pr-4', null);
      // 无 P 状态需要 2 道选择题：再补一道库存，避免触发懒生成
      await seedQuestion(db, 'pr-4', {
        type: 'understanding',
        payloadJson: choicePayload(DEFAULT_OPTIONS, '第二道'),
        correctOptionId: 'o1',
        contextText: 'Another ____ sentence.',
        promptText: 'stable 在这里什么意思？',
      });
    });
    const stockIds = ctx.db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.learningItemId, 'pr-4'))
      .all()
      .map((r) => r.id);
    expect(stockIds).toHaveLength(4);
    const body = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-4/practice')).json(),
    );
    expect(body.questions).toHaveLength(3);
    expect(body.questions.every((q) => stockIds.includes(q.questionId))).toBe(true);
    expect(new Set(body.questions.map((q) => q.questionId)).size).toBe(3); // 不重复取同一题
  });

  it('item 不存在 → 404', async () => {
    const ctx = await newCtx(async () => {});
    const res = await post(ctx, '/api/library/no-such/practice');
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/library/:id/practice/:questionId/answer', () => {
  it('选择题：pass/fail 判定与揭示；零状态影响（review_states/next_review_at/status/daily_stats 全不变）', async () => {
    const ctx = await newCtx(async (db) => {
      await seedWithP(db, 'pr-10', 3);
    });
    const start = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-10/practice')).json(),
    );
    const choice = start.questions.find((q) => q.qtype === 'choice')!;
    if (choice.qtype !== 'choice') throw new Error('unreachable');

    const stateBefore = ctx.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'pr-10'))
      .all();
    const itemBefore = ctx.db
      .select()
      .from(learningItems)
      .where(eq(learningItems.id, 'pr-10'))
      .get()!;

    const ok = await post(ctx, `/api/library/pr-10/practice/${choice.questionId}/answer`, {
      selectedOptionId: 'o1',
    });
    const okBody = PracticeAnswerResponse.parse(ok.json());
    expect(ok.statusCode).toBe(200);
    expect(okBody.result).toBe('pass');
    expect(okBody.correct).toBe(true);
    expect(okBody.explanation).toBeNull();
    expect(okBody.personalExampleSaved).toBe(false);

    const bad = await post(ctx, `/api/library/pr-10/practice/${choice.questionId}/answer`, {
      selectedOptionId: 'o2',
    });
    const badBody = PracticeAnswerResponse.parse(bad.json());
    expect(badBody.result).toBe('fail');
    expect(badBody.explanation).toBe('理解解释');
    expect(badBody.correctOptionId).toBe('o1');

    // 零状态影响
    expect(
      ctx.db.select().from(reviewStates).where(eq(reviewStates.learningItemId, 'pr-10')).all(),
    ).toEqual(stateBefore);
    const itemAfter = ctx.db
      .select()
      .from(learningItems)
      .where(eq(learningItems.id, 'pr-10'))
      .get()!;
    expect(itemAfter.status).toBe(itemBefore.status);
    expect(itemAfter.queueState).toBe(itemBefore.queueState);
    expect(ctx.db.select().from(dailyStats).all()).toHaveLength(0);

    const rows = ctx.db
      .select()
      .from(attempts)
      .where(eq(attempts.questionId, choice.questionId))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.mode === 'library_practice' && r.reviewTaskId === null)).toBe(true);
  });

  it('填空题：判定与完整句揭示；不写 daily_stats', async () => {
    const ctx = await newCtx(async (db) => {
      await seedWithP(db, 'pr-11', 3);
    });
    const start = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-11/practice')).json(),
    );
    const cloze = start.questions.find((q) => q.qtype === 'cloze')!;
    if (cloze.qtype !== 'cloze') throw new Error('unreachable');

    const res = await post(ctx, `/api/library/pr-11/practice/${cloze.questionId}/answer`, {
      answerText: ' stable ',
    });
    const body = PracticeAnswerResponse.parse(res.json());
    expect(body.result).toBe('pass');
    expect(body.completeSentence).toBe('The connection is stable.');
    expect(body.acceptedAnswer).toBe('stable');
    expect(ctx.db.select().from(dailyStats).all()).toHaveLength(0);
  });

  it('表达题：correction 返回、优质句沉淀 personal、attempt 携带 prompt 元数据、零状态影响', async () => {
    const ctx = await newCtx(async (db) => {
      await seedWithP(db, 'pr-12', 4);
    });
    const start = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-12/practice')).json(),
    );
    const prod = start.questions.find((q) => q.qtype === 'production')!;
    if (prod.qtype !== 'production') throw new Error('unreachable');

    const stateBefore = ctx.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'pr-12'))
      .all();

    const res = await post(ctx, `/api/library/pr-12/practice/${prod.questionId}/answer`, {
      answerText: 'The bridge is stable enough for now.',
    });
    expect(res.statusCode).toBe(200);
    const body = PracticeAnswerResponse.parse(res.json());
    expect(body.result).toBe('pass');
    expect(body.correction).toEqual({
      segments: [{ text: 'The bridge is stable enough for now.', type: 'same' }],
      correctedSentence: 'The bridge is stable enough for now.',
      betterVersion: null,
    });
    expect(body.personalExampleSaved).toBe(true);

    // personal example 沉淀（PRODUCT §4.4：练一下仍可入长期资产）
    const personal = ctx.db
      .select()
      .from(learningExamples)
      .where(eq(learningExamples.learningItemId, 'pr-12'))
      .all()
      .filter((e) => e.kind === 'personal');
    expect(personal).toHaveLength(1);
    expect(personal[0]!.text).toBe('The bridge is stable enough for now.');

    // attempt：mode=library_practice、无 review_task、无补强、元数据齐全
    const attempt = ctx.db
      .select()
      .from(attempts)
      .where(eq(attempts.questionId, prod.questionId))
      .all()[0]!;
    expect(attempt.mode).toBe('library_practice');
    expect(attempt.reviewTaskId).toBeNull();
    expect(attempt.result).toBe('pass');
    expect(attempt.aiPromptKey).toBe('check_production');

    // 零状态影响 + 不写 daily_stats
    expect(
      ctx.db.select().from(reviewStates).where(eq(reviewStates.learningItemId, 'pr-12')).all(),
    ).toEqual(stateBefore);
    expect(ctx.db.select().from(dailyStats).all()).toHaveLength(0);
  });

  it('表达题批改失败 → AI_PROVIDER_ERROR 且零写入', async () => {
    const ctx = await newCtx(async (db) => {
      await seedWithP(db, 'pr-13', 4);
    });
    setPracticeDepsForTests(practiceFakes()); // 默认成功 fake；下面换失败
    const start = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-13/practice')).json(),
    );
    const prod = start.questions.find((q) => q.qtype === 'production')!;

    const failing = createFakeDeps({ productionFail: true });
    setPracticeDepsForTests({
      acquire: failing.acquire,
      generate: failing.generate,
      evaluateChoice: failing.evaluateChoice,
      evaluateCloze: failing.evaluateCloze,
      evaluateProduction: failing.evaluateProduction,
    });
    const res = await post(ctx, `/api/library/pr-13/practice/${prod.questionId}/answer`, {
      answerText: 'some text',
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('AI_PROVIDER_ERROR');
    expect(ctx.db.select().from(attempts).all()).toHaveLength(0);
  });

  it('题目不存在 / 属于其他 item / 答案缺失 → 404 / 404 / 400', async () => {
    const ctx = await newCtx(async (db) => {
      await seedWithP(db, 'pr-14', null);
      await seedWithP(db, 'pr-15', null);
    });
    const noSuch = await post(ctx, '/api/library/pr-14/practice/no-such-q/answer', {
      selectedOptionId: 'o1',
    });
    expect(noSuch.statusCode).toBe(404);

    const start15 = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-15/practice')).json(),
    );
    const other = start15.questions[0]!;
    const crossItem = await post(ctx, `/api/library/pr-14/practice/${other.questionId}/answer`, {
      selectedOptionId: 'o1',
    });
    expect(crossItem.statusCode).toBe(404);

    const start14 = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-14/practice')).json(),
    );
    const choice = start14.questions.find((q) => q.qtype === 'choice')!;
    const missing = await post(ctx, `/api/library/pr-14/practice/${choice.questionId}/answer`, {});
    expect(missing.statusCode).toBe(400);
  });
});
