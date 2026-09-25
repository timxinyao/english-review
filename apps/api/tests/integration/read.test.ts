import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { ReadArticleView, ReadHistoryResponse } from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import {
  attempts,
  dailyStats,
  learningItems,
  readArticleItems,
  readArticles,
  reviewSessions,
  reviewStates,
} from '../../src/db/schema.js';
import {
  setReadDepsForTests,
  type ReadDeps,
  type ReadGeneration,
  type ReadSelection,
} from '../../src/modules/read/service.js';
import { createTestApp, loginCookie } from '../helpers/test-app';
import { seedItem, seedReviewState } from '../helpers/seed';

const apps: FastifyInstance[] = [];
const NOW = new Date('2026-09-24T02:00:00.000Z');
const DAY_MS = 24 * 3600 * 1000;

const PARA =
  'The morning was quiet and the light came slowly through the kitchen window. ' +
  'She poured a cup of tea and read the same page twice without noticing. ' +
  'Outside, a neighbor watered the plants, and the city began to move in its usual gentle rhythm.';

let db: AppDatabase;
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  const ctx = createTestApp();
  apps.push(ctx.app);
  db = ctx.db;
  app = ctx.app;
  cookie = await loginCookie(ctx.app);
  setReadDepsForTests(fakeReadDeps());
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

function fakeReadDeps(): ReadDeps {
  return { generate: (input) => Promise.resolve(fakeReadResult(input)) };
}

function fakeReadResult(input: ReadSelection): ReadGeneration {
  const body = [
    PARA,
    input.focusItems
      .map((f) => `Later that day, people kept saying that ${f.target} matters.`)
      .join(' '),
    PARA,
  ].join('\n\n');
  return {
    data: {
      title: 'Fake Read',
      type: 'daily_scene',
      body,
      coverage: input.focusItems.map((f) => ({
        learning_item_id: f.id,
        surface_form: f.target,
      })),
      checks: input.focusItems.slice(0, 2).map((f) => ({
        learning_item_id: f.id,
        question: `文中 ${f.target} 的意思是什么？`,
        options: [
          { id: 'o1', text: f.meaning },
          { id: 'o2', text: '干扰甲' },
          { id: 'o3', text: '干扰乙' },
          { id: 'o4', text: '干扰丙' },
        ],
        correct_option_id: 'o1',
      })),
    },
    meta: { key: 'generate_read', version: 1, hash: 'test-hash' },
    model: 'mock-model',
  };
}

async function inject(
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ statusCode: number; json: unknown }> {
  const res = await app.inject({ method, url, headers: { cookie }, payload });
  return { statusCode: res.statusCode, json: res.json() };
}

/** 3 个弱项（focus 候选）+1 个 mastered 项（old 候选） */
async function seedForGenerate(): Promise<void> {
  for (const [id, target, meaning] of [
    ['focus-1', 'wear down', '逐渐消耗'],
    ['focus-2', 'raw', '未经处理的'],
    ['focus-3', 'make sense', '讲得通'],
  ] as const) {
    await seedItem(db, { id, target, meaning, queueState: 'started' });
    await seedReviewState(db, id, 'understanding', {
      level: 2,
      nextReviewAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
    });
  }
  await seedItem(db, { id: 'old-1', target: 'stable', meaning: '稳定的', status: 'mastered' });
  await seedReviewState(db, 'old-1', 'understanding', { level: 7, stable: 1 });
}

describe('POST /api/read/generate', () => {
  it('生成入库：article/items/checks_json 字段完整，返回视图不含 correctOptionId', async () => {
    await seedForGenerate();

    const { statusCode, json } = await inject('POST', '/api/read/generate');
    expect(statusCode).toBe(200);
    const view = ReadArticleView.parse(json);

    expect(view.title).toBe('Fake Read');
    expect(view.type).toBe('daily_scene');
    expect(view.contentLevel).toBe('B1');
    expect(view.favorite).toBe(false);
    expect(view.focusItems.map((f) => f.target)).toEqual(['wear down', 'raw', 'make sense']);
    expect(view.focusItems.map((f) => f.surfaceForm)).toEqual(['wear down', 'raw', 'make sense']);
    expect(view.oldItems.map((o) => o.learningItemId)).toEqual(['old-1']);
    expect(view.body.split('\n\n')).toHaveLength(3);
    // 检查题视图不含正确答案
    expect(view.checks).toHaveLength(2);
    for (const c of view.checks) {
      expect('correctOptionId' in c).toBe(false);
      expect(c.options).toHaveLength(4);
    }

    // 入库断言
    const article = db.select().from(readArticles).where(eq(readArticles.id, view.id)).get()!;
    expect(article).toBeTruthy();
    expect(article.title).toBe('Fake Read');
    expect(article.type).toBe('daily_scene');
    expect(article.contentLevel).toBe('B1');
    expect(article.favorite).toBe(0);
    expect(article.promptKey).toBe('generate_read');
    expect(article.promptVersion).toBe(1);
    expect(article.promptHash).toBe('test-hash');
    expect(article.model).toBe('mock-model');
    expect(article.createdAt).toBe(view.createdAt);
    // expires = created + 30 天
    expect(article.expiresAt).toBe(
      new Date(new Date(view.createdAt).getTime() + 30 * DAY_MS).toISOString(),
    );

    const items = db
      .select()
      .from(readArticleItems)
      .where(eq(readArticleItems.readArticleId, view.id))
      .all();
    expect(items.filter((i) => i.role === 'focus').every((i) => i.highlighted === 1)).toBe(true);
    expect(items.filter((i) => i.role === 'old').every((i) => i.highlighted === 0)).toBe(true);
    expect(items).toHaveLength(4);

    // checks_json 含服务端判题信息
    const checks = JSON.parse(article.checksJson) as Array<{
      id: string;
      correctOptionId: string;
      answered?: unknown;
    }>;
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.correctOptionId === 'o1' && !c.answered)).toBe(true);
    expect(view.checks.map((c) => c.checkId)).toEqual(checks.map((c) => c.id));
  });

  it('无可用学习项 → 409 CONFLICT', async () => {
    const { statusCode, json } = await inject('POST', '/api/read/generate');
    expect(statusCode).toBe(409);
    expect((json as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('AI 生成失败 → 502 AI_PROVIDER_ERROR，不产生脏数据', async () => {
    await seedForGenerate();
    setReadDepsForTests({
      generate: () => Promise.reject(new Error('模型超时')),
    });
    const { statusCode, json } = await inject('POST', '/api/read/generate');
    expect(statusCode).toBe(502);
    expect((json as { error: { code: string } }).error.code).toBe('AI_PROVIDER_ERROR');
    expect(db.select().from(readArticles).all()).toHaveLength(0);
  });
});

describe('GET /api/read/history', () => {
  function seedHistoryArticle(
    id: string,
    createdAt: string,
    opts: { favorite?: number; expiresAt?: string | null; body?: string; type?: string } = {},
  ): void {
    db.insert(readArticles)
      .values({
        id,
        title: `title-${id}`,
        body: opts.body ?? 'one two three four five',
        type: opts.type ?? 'story',
        contentLevel: 'B1',
        favorite: opts.favorite ?? 0,
        promptKey: 'generate_read',
        promptVersion: 1,
        promptHash: 'h',
        model: 'm',
        checksJson: '[]',
        createdAt,
        expiresAt:
          opts.expiresAt === undefined
            ? new Date(NOW.getTime() + 30 * DAY_MS).toISOString()
            : opts.expiresAt,
      })
      .run();
  }

  beforeEach(async () => {
    await seedForGenerate();
    // 4 篇：normal-a/b、favorite、expired
    seedHistoryArticle('normal-a', '2026-09-20T00:00:00.000Z', { body: 'a b c d e f' });
    seedHistoryArticle('normal-b', '2026-09-22T00:00:00.000Z', {
      body: 'a b c',
      type: 'knowledge',
    });
    seedHistoryArticle('fav-1', '2026-09-23T00:00:00.000Z', { favorite: 1 });
    seedHistoryArticle('expired-1', '2026-09-01T00:00:00.000Z', {
      expiresAt: '2026-09-10T00:00:00.000Z',
    });
  });

  it('排除已过期，按 created DESC，wordCount 为正文词数', async () => {
    const { statusCode, json } = await inject('GET', '/api/read/history');
    expect(statusCode).toBe(200);
    const res = ReadHistoryResponse.parse(json);
    expect(res.total).toBe(3);
    expect(res.items.map((i) => i.id)).toEqual(['fav-1', 'normal-b', 'normal-a']);
    expect(res.items.map((i) => i.wordCount)).toEqual([5, 3, 6]);
    expect(res.items[0]!.favorite).toBe(true);
    expect(res.items[1]!.type).toBe('knowledge');
  });

  it('favorite 筛选与分页', async () => {
    const fav = await inject('GET', '/api/read/history?favorite=true');
    const favRes = ReadHistoryResponse.parse(fav.json);
    expect(favRes.items.map((i) => i.id)).toEqual(['fav-1']);
    expect(favRes.total).toBe(1);

    const page = await inject('GET', '/api/read/history?page=2&pageSize=2');
    const pageRes = ReadHistoryResponse.parse(page.json);
    expect(pageRes.items.map((i) => i.id)).toEqual(['normal-a']);
    expect(pageRes.total).toBe(3);
    expect(pageRes.page).toBe(2);
    expect(pageRes.pageSize).toBe(2);
  });
});

describe('POST /api/read/:id/favorite', () => {
  beforeEach(async () => {
    await seedForGenerate();
    await inject('POST', '/api/read/generate');
  });

  it('favorite=true → favorite=1 且 expires_at=null（永久）', async () => {
    const article = db.select().from(readArticles).all()[0]!;
    const { statusCode, json } = await inject('POST', `/api/read/${article.id}/favorite`, {
      favorite: true,
    });
    expect(statusCode).toBe(200);
    expect(json).toEqual({ ok: true, favorite: true });

    const row = db.select().from(readArticles).where(eq(readArticles.id, article.id)).get()!;
    expect(row.favorite).toBe(1);
    expect(row.expiresAt).toBeNull();
  });

  it('favorite=false → favorite=0 且 expires_at=created+30 天', async () => {
    const article = db.select().from(readArticles).all()[0]!;
    await inject('POST', `/api/read/${article.id}/favorite`, { favorite: true });
    const { statusCode, json } = await inject('POST', `/api/read/${article.id}/favorite`, {
      favorite: false,
    });
    expect(statusCode).toBe(200);
    expect(json).toEqual({ ok: true, favorite: false });

    const row = db.select().from(readArticles).where(eq(readArticles.id, article.id)).get()!;
    expect(row.favorite).toBe(0);
    expect(row.expiresAt).toBe(
      new Date(new Date(row.createdAt).getTime() + 30 * DAY_MS).toISOString(),
    );
  });

  it('文章不存在 → 404', async () => {
    const { statusCode } = await inject('POST', '/api/read/nope/favorite', { favorite: true });
    expect(statusCode).toBe(404);
  });
});

describe('POST /api/read/:id/check', () => {
  let articleId: string;
  let check1: { checkId: string; options: Array<{ id: string }> };
  let check2: { checkId: string; options: Array<{ id: string }> };

  beforeEach(async () => {
    await seedForGenerate();
    const view = ReadArticleView.parse((await inject('POST', '/api/read/generate')).json);
    articleId = view.id;
    check1 = view.checks[0]!;
    check2 = view.checks[1]!;
  });

  it('答错：correct=false、置 needs_reinforcement、写 read_check attempt；不影响 review/daily_stats/Today', async () => {
    const before = db.select().from(reviewStates).all();
    const { statusCode, json } = await inject('POST', `/api/read/${articleId}/check`, {
      checkId: check1.checkId,
      selectedOptionId: 'o2',
    });
    expect(statusCode).toBe(200);
    expect(json).toMatchObject({
      correct: false,
      correctOptionId: 'o1',
      needsReinforcementMarked: true,
    });

    const item = db.select().from(learningItems).where(eq(learningItems.id, 'focus-1')).get()!;
    expect(item.needsReinforcement).toBe(1);

    const rows = db.select().from(attempts).where(eq(attempts.mode, 'read_check')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.learningItemId).toBe('focus-1');
    expect(rows[0]!.questionId).toBeNull();
    expect(rows[0]!.reviewTaskId).toBeNull();
    expect(rows[0]!.result).toBe('fail');
    expect(rows[0]!.selectedOptionId).toBe('o2');

    // Read 不推进任何正式状态
    expect(db.select().from(reviewStates).all()).toEqual(before);
    expect(db.select().from(dailyStats).all()).toEqual([]);
    expect(db.select().from(reviewSessions).all()).toEqual([]);
  });

  it('答对：correct=true、不置旗、也不清已有旗', async () => {
    // 预置另一项的旗（应由正式复习清除，Read 答对不清）
    db.update(learningItems)
      .set({ needsReinforcement: 1 })
      .where(eq(learningItems.id, 'focus-2'))
      .run();

    const { statusCode, json } = await inject('POST', `/api/read/${articleId}/check`, {
      checkId: check2.checkId,
      selectedOptionId: 'o1',
    });
    expect(statusCode).toBe(200);
    expect(json).toMatchObject({ correct: true, needsReinforcementMarked: false });

    const item = db.select().from(learningItems).where(eq(learningItems.id, 'focus-2')).get()!;
    expect(item.needsReinforcement).toBe(1); // 旗保持
    const rows = db.select().from(attempts).where(eq(attempts.mode, 'read_check')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toBe('pass');
  });

  it('幂等：同 checkId 重复提交返回首次结果，不重复记 attempt', async () => {
    const first = await inject('POST', `/api/read/${articleId}/check`, {
      checkId: check1.checkId,
      selectedOptionId: 'o2',
    });
    expect(first.json).toMatchObject({ correct: false });

    // 换一个选项重提交：仍返回首次判定
    const again = await inject('POST', `/api/read/${articleId}/check`, {
      checkId: check1.checkId,
      selectedOptionId: 'o1',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json).toMatchObject({
      correct: false,
      correctOptionId: 'o1',
      needsReinforcementMarked: true,
    });

    expect(db.select().from(attempts).where(eq(attempts.mode, 'read_check')).all()).toHaveLength(1);
    // answered 已持久化到 checks_json（重启安全）
    const stored = JSON.parse(
      db.select().from(readArticles).where(eq(readArticles.id, articleId)).get()!.checksJson,
    ) as Array<{ answered?: unknown }>;
    expect(stored[0]!.answered).toBeTruthy();
  });

  it('checkId 不存在 → 404', async () => {
    const { statusCode } = await inject('POST', `/api/read/${articleId}/check`, {
      checkId: 'nope',
      selectedOptionId: 'o1',
    });
    expect(statusCode).toBe(404);
  });

  it('文章不存在 → 404', async () => {
    const { statusCode } = await inject('POST', '/api/read/nope/check', {
      checkId: 'c',
      selectedOptionId: 'o1',
    });
    expect(statusCode).toBe(404);
  });
});
