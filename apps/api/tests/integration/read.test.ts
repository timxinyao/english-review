import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { GenerateReadResult, ReadArticleView, ReadHistoryResponse } from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import {
  appMetadata,
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
import { applyV2Cutover } from '../../src/modules/review/v2-cutover.js';
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
    // V2：纯阅读——title/type/body/coverage，无 checks
    data: {
      title: 'Fake Read',
      type: 'daily_scene',
      body,
      coverage: input.focusItems.map((f) => ({
        learning_item_id: f.id,
        surface_form: f.target,
      })),
    },
    meta: { key: 'generate_read', version: 2, hash: 'test-hash' },
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
      difficulty: 5,
      stability: 5,
      reps: 2,
      nextReviewAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
    });
  }
  await seedItem(db, { id: 'old-1', target: 'stable', meaning: '稳定的', status: 'mastered' });
  await seedReviewState(db, 'old-1', 'understanding', { difficulty: 5, stability: 130, reps: 8 });
}

/** 遗留（V1）文章：checks_json 含一答对 + 一未答检查题 */
function seedLegacyArticle(id = 'legacy-art'): void {
  const nowIso = NOW.toISOString();
  db.insert(readArticles)
    .values({
      id,
      title: 'Legacy Article',
      body: 'The plan felt stable all week.\n\nThe raw data wore her down.',
      type: 'story',
      contentLevel: 'B1',
      favorite: 0,
      promptKey: 'generate_read',
      promptVersion: 1,
      promptHash: 'legacy-hash',
      model: 'legacy-model',
      checksJson: JSON.stringify([
        {
          id: 'chk-answered',
          learningItemId: 'focus-1',
          question: '文中 wear down 的意思是什么？',
          options: [
            { id: 'o1', text: '逐渐消耗' },
            { id: 'o2', text: '干扰甲' },
          ],
          correctOptionId: 'o1',
          answered: {
            selectedOptionId: 'o2',
            correct: false,
            needsReinforcementMarked: true,
          },
        },
        {
          id: 'chk-open',
          learningItemId: 'focus-2',
          question: '文中 raw 的意思是什么？',
          options: [
            { id: 'o1', text: '未经处理的' },
            { id: 'o2', text: '干扰乙' },
          ],
          correctOptionId: 'o1',
        },
      ]),
      createdAt: nowIso,
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
    })
    .run();
  for (const [itemId, role] of [
    ['focus-1', 'focus'],
    ['focus-2', 'focus'],
  ] as const) {
    db.insert(readArticleItems)
      .values({ readArticleId: id, learningItemId: itemId, role, highlighted: 1 })
      .run();
  }
}

describe('GenerateReadResult V2 Schema（纯阅读，无 checks）', () => {
  it('接受 title/type/body/coverage；模型输出含 checks 字段必须拒绝', () => {
    const base = {
      title: 'A Quiet Morning',
      type: 'story',
      body: 'word '.repeat(200).trim(),
      coverage: [{ learning_item_id: 'item-1', surface_form: 'word' }],
    };
    expect(GenerateReadResult.safeParse(base).success).toBe(true);
    // 模型若仍输出 V1 的 checks，视为违反契约（completeStructured 拒绝并重试）
    const withChecks = {
      ...base,
      checks: [
        {
          learning_item_id: 'item-1',
          question: '文中 word 的意思是什么？',
          options: [
            { id: 'o1', text: '词' },
            { id: 'o2', text: '干扰' },
          ],
          correct_option_id: 'o1',
        },
      ],
    };
    expect(GenerateReadResult.safeParse(withChecks).success).toBe(false);
  });
});

describe('POST /api/read/generate', () => {
  it('生成入库：纯文章无 checks，checks_json 存 []，返回视图 checks=[]', async () => {
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
    expect(view.checks).toEqual([]);

    // 入库断言
    const article = db.select().from(readArticles).where(eq(readArticles.id, view.id)).get()!;
    expect(article).toBeTruthy();
    expect(article.title).toBe('Fake Read');
    expect(article.type).toBe('daily_scene');
    expect(article.contentLevel).toBe('B1');
    expect(article.favorite).toBe(0);
    expect(article.promptKey).toBe('generate_read');
    expect(article.promptVersion).toBe(2);
    expect(article.promptHash).toBe('test-hash');
    expect(article.model).toBe('mock-model');
    expect(article.createdAt).toBe(view.createdAt);
    // expires = created + 30 天
    expect(article.expiresAt).toBe(
      new Date(new Date(view.createdAt).getTime() + 30 * DAY_MS).toISOString(),
    );
    // V2：新文章不再携带检查题
    expect(article.checksJson).toBe('[]');

    const items = db
      .select()
      .from(readArticleItems)
      .where(eq(readArticleItems.readArticleId, view.id))
      .all();
    expect(items.filter((i) => i.role === 'focus').every((i) => i.highlighted === 1)).toBe(true);
    expect(items.filter((i) => i.role === 'old').every((i) => i.highlighted === 0)).toBe(true);
    expect(items).toHaveLength(4);
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
        promptVersion: 2,
        promptHash: 'h',
        model: 'm',
        checksJson: '[]',
        createdAt,
        expiresAt:
          opts.expiresAt === undefined
            ? new Date(Date.now() + 30 * DAY_MS).toISOString() // 相对真实运行时间（固定 NOW+30d 2026-10-24 起全过期）
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

describe('POST /api/read/:id/check（V2 cutover 后停用）', () => {
  beforeEach(async () => {
    await seedForGenerate();
    await inject('POST', '/api/read/generate'); // 新文章（无 checks）
    seedLegacyArticle();
    // 模拟 V2 首次启动：写入 foxi_v2 标记
    applyV2Cutover(db, NOW, 'UTC');
    expect(db.select().from(appMetadata).where(eq(appMetadata.key, 'foxi_v2')).get()).toBeTruthy();
  });

  it('旧文章的检查题提交 → 409，不写 attempt、不置旗、checks_json 原样', async () => {
    const before = db.select().from(readArticles).where(eq(readArticles.id, 'legacy-art')).get()!;

    const { statusCode, json } = await inject('POST', '/api/read/legacy-art/check', {
      checkId: 'chk-open',
      selectedOptionId: 'o1',
    });
    expect(statusCode).toBe(409);
    expect((json as { error: { code: string } }).error.code).toBe('CONFLICT');

    expect(db.select().from(attempts).where(eq(attempts.mode, 'read_check')).all()).toHaveLength(0);
    expect(
      db
        .select()
        .from(learningItems)
        .all()
        .every((i) => i.needsReinforcement === 0),
    ).toBe(true);
    const after = db.select().from(readArticles).where(eq(readArticles.id, 'legacy-art')).get()!;
    expect(after.checksJson).toBe(before.checksJson);
  });

  it('新文章（无 checks）的提交同样 → 409', async () => {
    const article = db
      .select()
      .from(readArticles)
      .all()
      .find((a) => a.id !== 'legacy-art')!;
    const { statusCode } = await inject('POST', `/api/read/${article.id}/check`, {
      checkId: 'any',
      selectedOptionId: 'o1',
    });
    expect(statusCode).toBe(409);
    expect(db.select().from(attempts).where(eq(attempts.mode, 'read_check')).all()).toHaveLength(0);
  });
});

describe('POST /api/read/:id/check（cutover 前遗留窗口：可判定但不再置旗）', () => {
  let articleId: string;
  let check1: { checkId: string; options: Array<{ id: string }> };
  let check2: { checkId: string; options: Array<{ id: string }> };

  beforeEach(async () => {
    await seedForGenerate();
    seedLegacyArticle();
    articleId = 'legacy-art';
    const stored = JSON.parse(
      db.select().from(readArticles).where(eq(readArticles.id, articleId)).get()!.checksJson,
    ) as Array<{ id: string }>;
    check1 = { checkId: stored[0]!.id, options: [] };
    check2 = { checkId: stored[1]!.id, options: [] };
  });

  it('未答检查题判定：写 read_check attempt，但绝不置 needs_reinforcement；不影响 review/daily_stats/Today', async () => {
    const before = db.select().from(reviewStates).all();
    const { statusCode, json } = await inject('POST', `/api/read/${articleId}/check`, {
      checkId: check2.checkId,
      selectedOptionId: 'o2',
    });
    expect(statusCode).toBe(200);
    expect(json).toMatchObject({ correct: false, correctOptionId: 'o1' });

    // V2：Read 路径不置补强旗
    const item = db.select().from(learningItems).where(eq(learningItems.id, 'focus-2')).get()!;
    expect(item.needsReinforcement).toBe(0);

    const rows = db.select().from(attempts).where(eq(attempts.mode, 'read_check')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.learningItemId).toBe('focus-2');
    expect(rows[0]!.questionId).toBeNull();
    expect(rows[0]!.reviewTaskId).toBeNull();
    expect(rows[0]!.result).toBe('fail');
    expect(rows[0]!.selectedOptionId).toBe('o2');

    // Read 不推进任何正式状态
    expect(db.select().from(reviewStates).all()).toEqual(before);
    expect(db.select().from(dailyStats).all()).toEqual([]);
    expect(db.select().from(reviewSessions).all()).toEqual([]);
  });

  it('已答检查题幂等回放：返回首次结果，不重复记 attempt，不置旗', async () => {
    const first = await inject('POST', `/api/read/${articleId}/check`, {
      checkId: check1.checkId,
      selectedOptionId: 'o1',
    });
    expect(first.statusCode).toBe(200);
    // 首答记录是 V1 历史数据（selectedOptionId=o2、needsReinforcementMarked=true）
    expect(first.json).toMatchObject({ correct: false, correctOptionId: 'o1' });

    expect(db.select().from(attempts).where(eq(attempts.mode, 'read_check')).all()).toHaveLength(0);
    const item = db.select().from(learningItems).where(eq(learningItems.id, 'focus-1')).get()!;
    expect(item.needsReinforcement).toBe(0);
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
