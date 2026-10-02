import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
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
import {
  choicePayload,
  createFakeDeps,
  type FakeDepsOptions,
  DEFAULT_OPTIONS,
} from '../helpers/today-fakes';

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
function practiceFakes(opts: FakeDepsOptions = {}): PracticeDeps {
  const f = createFakeDeps(opts);
  return {
    acquire: f.acquire,
    generate: f.generate,
    evaluateChoice: f.evaluateChoice,
    evaluateProduction: f.evaluateProduction,
  };
}

async function post(ctx: Ctx, url: string, payload?: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url, headers: { cookie: ctx.cookie }, payload });
}

// ---------------------------------------------------------------------------
// V2（Phase 9）种子：practice 一律 [recall] 或 [recall, production]，无 cloze。
// 释义（meaning）只允许出现在作答响应（reveal），start 响应绝不泄漏。
// ---------------------------------------------------------------------------

const SOURCE_EXAMPLE = 'The connection has been stable all week.';
const MEANING = '测试释义';

const PROD_PAYLOAD = JSON.stringify({
  mustUse: 'stable',
  referenceAnswer: 'The connection is stable.',
  acceptanceNotes: '允许变化。',
});

interface SeedOpts {
  type?: 'word' | 'chunk';
  override?: number | null;
  pLevel?: number | null;
  understandingStock?: boolean;
  clozeStock?: boolean;
  productionStock?: boolean;
}

async function seedV2Item(db: AppDatabase, itemId: string, opts: SeedOpts = {}): Promise<void> {
  const {
    type = 'word',
    override = null,
    pLevel = null,
    understandingStock = true,
    clozeStock = false,
    productionStock = true,
  } = opts;
  await seedItem(db, {
    id: itemId,
    type,
    productionEnabledOverride: override,
    target: 'stable',
    meaning: MEANING,
    queueState: 'started',
  });
  await seedExample(db, itemId, 'source', SOURCE_EXAMPLE);
  if (pLevel !== null) {
    await seedReviewState(db, itemId, 'production', { level: pLevel, nextReviewAt: dayAgo() });
  }
  if (understandingStock) {
    await seedQuestion(db, itemId, {
      type: 'understanding',
      payloadJson: choicePayload(DEFAULT_OPTIONS, '理解解释'),
      correctOptionId: 'o1',
      contextText: 'A ____ sentence.',
      promptText: 'stable 最接近什么意思？',
    });
  }
  if (clozeStock) {
    await seedQuestion(db, itemId, {
      type: 'cloze',
      payloadJson: JSON.stringify({ acceptedAnswers: ['stable'], explanation: 'cloze 解释' }),
      promptText: 'The connection is ____.',
      correctOptionId: null,
    });
  }
  if (productionStock) {
    await seedQuestion(db, itemId, {
      type: 'production',
      promptText: '请使用 stable 描述一个稳定的连接。',
      payloadJson: PROD_PAYLOAD,
      correctOptionId: null,
    });
  }
}

afterAll(async () => {
  setPracticeDepsForTests(null);
  for (const app of apps) await app.close();
});

describe('POST /api/library/:id/practice（start，V2：Recall + 可选 Production）', () => {
  it('word（production 默认关，即便有 P 状态）：恰好 [recall]；target/原句在、释义不泄漏', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-1', { type: 'word', override: null, pLevel: 4 });
    });
    const res = await post(ctx, '/api/library/pr-1/practice');
    expect(res.statusCode).toBe(200);
    const body = PracticeStartResponse.parse(res.json());
    expect(body.questions.map((q) => q.qtype)).toEqual(['recall']);
    const recall = body.questions[0]!;
    if (recall.qtype !== 'recall') throw new Error('unreachable');
    expect(recall.questionId).toBeTruthy();
    expect(recall.target).toBe('stable');
    expect(recall.context).toBe(SOURCE_EXAMPLE);
    expect(recall.hint.kind).toBe('context_meaning');
    expect(recall.hint.context).toBe('A ____ sentence.');
    expect(recall.hint.question).toBe('stable 最接近什么意思？');
    expect(recall.hint.options).toHaveLength(4);
    // 揭示前不泄漏释义（reveal 只在作答响应）
    expect(JSON.stringify(res.json())).not.toContain(MEANING);
  });

  it('chunk（production 默认开）：恰好 [recall, production]；production 视图不含 reference', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-2', { type: 'chunk', override: null });
    });
    const res = await post(ctx, '/api/library/pr-2/practice');
    expect(res.statusCode).toBe(200);
    const body = PracticeStartResponse.parse(res.json());
    expect(body.questions.map((q) => q.qtype)).toEqual(['recall', 'production']);
    const prod = body.questions[1]!;
    if (prod.qtype !== 'production') throw new Error('unreachable');
    expect(prod.zhPrompt).toBe('请使用 stable 描述一个稳定的连接。');
    expect(prod.mustUse).toBe('stable');
    expect(JSON.stringify(res.json())).not.toContain('The connection is stable.');
    expect(JSON.stringify(res.json())).not.toContain(MEANING);
  });

  it('override 覆盖类型默认：word override=1 → [recall, production]；chunk override=0 → [recall]', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-3a', { type: 'word', override: 1 });
      await seedV2Item(db, 'pr-3b', { type: 'chunk', override: 0 });
    });
    const a = PracticeStartResponse.parse((await post(ctx, '/api/library/pr-3a/practice')).json());
    expect(a.questions.map((q) => q.qtype)).toEqual(['recall', 'production']);
    const b = PracticeStartResponse.parse((await post(ctx, '/api/library/pr-3b/practice')).json());
    expect(b.questions.map((q) => q.qtype)).toEqual(['recall']);
  });

  it('旧 P-L1 + cloze 库存也不出填空（Phase 9：P 阶段题一律 production）', async () => {
    const ctx = await newCtx(async (db) => {
      // 旧数据画像：P-L1（V1 映射填空）+ 历史 cloze 库存
      await seedV2Item(db, 'pr-4a', { type: 'word', override: 1, pLevel: 1, clozeStock: true });
      await seedV2Item(db, 'pr-4b', { type: 'word', override: null, pLevel: 1, clozeStock: true });
    });
    const a = PracticeStartResponse.parse((await post(ctx, '/api/library/pr-4a/practice')).json());
    expect(a.questions.map((q) => q.qtype)).toEqual(['recall', 'production']);
    const b = PracticeStartResponse.parse((await post(ctx, '/api/library/pr-4b/practice')).json());
    expect(b.questions.map((q) => q.qtype)).toEqual(['recall']);
    expect(JSON.stringify(a.questions)).not.toContain('cloze');
    expect(JSON.stringify(b.questions)).not.toContain('cloze');
  });

  it('库存优先：全部题来自库存且不重复（不依赖生成）', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-5', { type: 'chunk' });
      // 多余的 understanding 库存，验证取题排除已用 id
      await seedQuestion(db, 'pr-5', {
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
      .where(eq(questions.learningItemId, 'pr-5'))
      .all()
      .map((r) => r.id);
    expect(stockIds).toHaveLength(3);
    const body = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-5/practice')).json(),
    );
    expect(body.questions).toHaveLength(2);
    expect(body.questions.every((q) => stockIds.includes(q.questionId))).toBe(true);
    expect(new Set(body.questions.map((q) => q.questionId)).size).toBe(2); // 不重复取同一题
  });

  it('无 understanding 库存 → 懒生成一道（fake）并用于 recall', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-6', { understandingStock: false });
    });
    const res = await post(ctx, '/api/library/pr-6/practice');
    expect(res.statusCode).toBe(200);
    const body = PracticeStartResponse.parse(res.json());
    expect(body.questions.map((q) => q.qtype)).toEqual(['recall']);
    const recall = body.questions[0]!;
    if (recall.qtype !== 'recall') throw new Error('unreachable');
    expect(recall.hint.options.length).toBeGreaterThanOrEqual(2); // fake 生成的选项可用作 Hint
  });

  it('understanding 生成失败 → 502 AI_PROVIDER_ERROR；依赖恢复后重试成功', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-7', { understandingStock: false, productionStock: false });
    });
    setPracticeDepsForTests(practiceFakes({ generateFailFor: new Set(['pr-7:understanding']) }));
    const fail = await post(ctx, '/api/library/pr-7/practice');
    expect(fail.statusCode).toBe(502);
    expect(fail.json().error.code).toBe('AI_PROVIDER_ERROR');

    setPracticeDepsForTests(practiceFakes()); // AI 恢复 → 重试成功
    const ok = await post(ctx, '/api/library/pr-7/practice');
    expect(ok.statusCode).toBe(200);
    expect(PracticeStartResponse.parse(ok.json()).questions.map((q) => q.qtype)).toEqual([
      'recall',
    ]);
  });

  it('item 不存在 → 404', async () => {
    const ctx = await newCtx(async () => {});
    const res = await post(ctx, '/api/library/no-such/practice');
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/library/:id/practice/:questionId/answer（V2）', () => {
  it('Recall 直判：recalled→pass、forgot→fail；作答响应揭示释义；零状态影响', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-10', { type: 'word', override: 1, pLevel: 3 });
    });
    const start = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-10/practice')).json(),
    );
    const recall = start.questions[0]!;
    if (recall.qtype !== 'recall') throw new Error('unreachable');

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

    const ok = await post(ctx, `/api/library/pr-10/practice/${recall.questionId}/answer`, {
      recall: 'recalled',
    });
    const okBody = PracticeAnswerResponse.parse(ok.json());
    expect(ok.statusCode).toBe(200);
    expect(okBody.result).toBe('pass');
    expect(okBody.correct).toBe(true);
    expect(okBody.meaning).toBe(MEANING); // reveal 只在作答后
    expect(okBody.correctOptionId).toBeNull();
    expect(okBody.personalExampleSaved).toBe(false);

    const bad = await post(ctx, `/api/library/pr-10/practice/${recall.questionId}/answer`, {
      recall: 'forgot',
    });
    const badBody = PracticeAnswerResponse.parse(bad.json());
    expect(badBody.result).toBe('fail');
    expect(badBody.correct).toBe(false);
    expect(badBody.meaning).toBe(MEANING);

    // 零状态影响（review_states/next_review_at/status/daily_stats 全不变）
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
      .where(eq(attempts.questionId, recall.questionId))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.mode === 'library_practice' && r.reviewTaskId === null)).toBe(true);
    expect(rows.every((r) => r.selectedOptionId === null)).toBe(true); // 直判不带选项
  });

  it('Recall Hint：答对 basic_pass、答错 fail 揭示正确项与解释；零状态影响', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-11', { type: 'chunk', pLevel: 2 });
    });
    const start = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-11/practice')).json(),
    );
    const recall = start.questions[0]!;
    if (recall.qtype !== 'recall') throw new Error('unreachable');

    const stateBefore = ctx.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'pr-11'))
      .all();

    const ok = await post(ctx, `/api/library/pr-11/practice/${recall.questionId}/answer`, {
      selectedOptionId: 'o1',
      hintUsed: true,
    });
    const okBody = PracticeAnswerResponse.parse(ok.json());
    expect(ok.statusCode).toBe(200);
    expect(okBody.result).toBe('basic_pass'); // 提示后对 = 基础通过（与 Today Recall 判定一致）
    expect(okBody.correct).toBe(true);
    expect(okBody.meaning).toBe(MEANING);

    const bad = await post(ctx, `/api/library/pr-11/practice/${recall.questionId}/answer`, {
      selectedOptionId: 'o2',
    });
    const badBody = PracticeAnswerResponse.parse(bad.json());
    expect(badBody.result).toBe('fail');
    expect(badBody.explanation).toBe('理解解释');
    expect(badBody.correctOptionId).toBe('o1');
    expect(badBody.meaning).toBe(MEANING);

    expect(
      ctx.db.select().from(reviewStates).where(eq(reviewStates.learningItemId, 'pr-11')).all(),
    ).toEqual(stateBefore);
    expect(ctx.db.select().from(dailyStats).all()).toHaveLength(0);
    const rows = ctx.db
      .select()
      .from(attempts)
      .where(eq(attempts.questionId, recall.questionId))
      .all();
    expect(rows.map((r) => r.selectedOptionId)).toEqual(['o1', 'o2']);
    expect(rows.every((r) => r.mode === 'library_practice' && r.reviewTaskId === null)).toBe(true);
  });

  it('Recall 缺作答字段 → 400（空体 / 仅 hintUsed）', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-12', { type: 'word' });
    });
    const start = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-12/practice')).json(),
    );
    const recall = start.questions[0]!;
    const empty = await post(ctx, `/api/library/pr-12/practice/${recall.questionId}/answer`, {});
    expect(empty.statusCode).toBe(400);
    const hintOnly = await post(ctx, `/api/library/pr-12/practice/${recall.questionId}/answer`, {
      hintUsed: true,
    });
    expect(hintOnly.statusCode).toBe(400);
  });

  it('表达题：correction 返回、优质句沉淀 personal、attempt 携带 prompt 元数据、零状态影响', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-13', { type: 'word', override: 1, pLevel: 4 });
    });
    const start = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-13/practice')).json(),
    );
    const prod = start.questions[1]!;
    if (prod.qtype !== 'production') throw new Error('unreachable');

    const stateBefore = ctx.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'pr-13'))
      .all();

    const res = await post(ctx, `/api/library/pr-13/practice/${prod.questionId}/answer`, {
      answerText: 'The bridge is stable enough for now.',
    });
    expect(res.statusCode).toBe(200);
    const body = PracticeAnswerResponse.parse(res.json());
    expect(body.result).toBe('pass');
    expect(body.meaning).toBeNull(); // production 无 recall 揭示
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
      .where(eq(learningExamples.learningItemId, 'pr-13'))
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
      ctx.db.select().from(reviewStates).where(eq(reviewStates.learningItemId, 'pr-13')).all(),
    ).toEqual(stateBefore);
    expect(ctx.db.select().from(dailyStats).all()).toHaveLength(0);
  });

  it('表达题批改失败 → AI_PROVIDER_ERROR 且零写入（可重试）', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-14', { type: 'chunk' });
    });
    const start = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-14/practice')).json(),
    );
    const prod = start.questions[1]!;

    const failing = practiceFakes({ productionFail: true });
    setPracticeDepsForTests(failing);
    const res = await post(ctx, `/api/library/pr-14/practice/${prod.questionId}/answer`, {
      answerText: 'some text',
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('AI_PROVIDER_ERROR');
    expect(ctx.db.select().from(attempts).all()).toHaveLength(0);
  });

  it('旧 cloze 库存题直答 → 409（V2 练习已不支持填空）', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-15', { clozeStock: true });
    });
    const clozeId = ctx.db
      .select({ id: questions.id })
      .from(questions)
      .where(and(eq(questions.learningItemId, 'pr-15'), eq(questions.type, 'cloze')))
      .get()!.id;
    const res = await post(ctx, `/api/library/pr-15/practice/${clozeId}/answer`, {
      answerText: 'stable',
    });
    expect(res.statusCode).toBe(409);
    expect(ctx.db.select().from(attempts).all()).toHaveLength(0);
  });

  it('题目不存在 / 属于其他 item → 404 / 404', async () => {
    const ctx = await newCtx(async (db) => {
      await seedV2Item(db, 'pr-16', { type: 'word' });
      await seedV2Item(db, 'pr-17', { type: 'word' });
    });
    const noSuch = await post(ctx, '/api/library/pr-16/practice/no-such-q/answer', {
      recall: 'recalled',
    });
    expect(noSuch.statusCode).toBe(404);

    const start17 = PracticeStartResponse.parse(
      (await post(ctx, '/api/library/pr-17/practice')).json(),
    );
    const other = start17.questions[0]!;
    const crossItem = await post(ctx, `/api/library/pr-16/practice/${other.questionId}/answer`, {
      recall: 'recalled',
    });
    expect(crossItem.statusCode).toBe(404);
  });
});
