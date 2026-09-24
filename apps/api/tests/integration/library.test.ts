import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { LibraryItemDetail } from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import { attempts, questions } from '../../src/db/schema.js';
import { createTestApp, loginCookie, type TestApp } from '../helpers/test-app.js';
import { seedExample, seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';

const apps: FastifyInstance[] = [];
afterAll(async () => {
  for (const app of apps) await app.close();
});

async function newApp(): Promise<TestApp & { cookie: string }> {
  const ctx = createTestApp();
  apps.push(ctx.app);
  const cookie = await loginCookie(ctx.app);
  return { ...ctx, cookie };
}

const T = {
  t1: '2026-09-01T00:00:00.000Z',
  t2: '2026-09-02T00:00:00.000Z',
  t3: '2026-09-03T00:00:00.000Z',
  t4: '2026-09-04T00:00:00.000Z',
  nextU: '2026-09-10T00:00:00.000Z',
  nextP: '2026-09-05T00:00:00.000Z',
};

async function seedLibrary(db: AppDatabase) {
  const gravity = await seedItem(db, {
    type: 'word',
    target: 'gravity',
    meaning: '重力；严重性',
    source: 'Avatar S01E12',
    tagsJson: '["Avatar"]',
    createdAt: T.t1,
    updatedAt: T.t1,
  });
  await seedExample(db, gravity, 'source', 'Gravity is a force that pulls things down.', {
    createdAt: T.t1,
  });
  await seedExample(db, gravity, 'extra', 'Keep a steady pace in zero gravity.', {
    sortOrder: 0,
    createdAt: T.t1,
  });
  const personalId = await seedExample(
    db,
    gravity,
    'personal',
    'The gravity of the situation surprised me.',
    { qualityScore: 0.9, pinned: 1, sortOrder: 0, createdAt: T.t1 },
  );
  await seedReviewState(db, gravity, 'understanding', { level: 3, nextReviewAt: T.nextU });
  await seedReviewState(db, gravity, 'production', { level: 0 });

  const wearDown = await seedItem(db, {
    type: 'chunk',
    target: 'wear down',
    meaning: '逐渐使疲惫；消耗',
    createdAt: T.t2,
    updatedAt: T.t2,
  });
  await seedExample(db, wearDown, 'source', 'It wears you down.', { createdAt: T.t2 });
  await seedReviewState(db, wearDown, 'understanding', { level: 7, stable: 1 });
  await seedReviewState(db, wearDown, 'production', { level: 2, nextReviewAt: T.nextP });

  const raw = await seedItem(db, {
    type: 'word',
    target: 'raw',
    meaning: '生的；未加工的',
    status: 'paused',
    createdAt: T.t3,
    updatedAt: T.t3,
  });
  await seedExample(db, raw, 'source', 'The raw data is messy.', { createdAt: T.t3 });

  const steady = await seedItem(db, {
    type: 'word',
    target: 'steady',
    meaning: '稳定的',
    status: 'archived',
    createdAt: T.t4,
    updatedAt: T.t4,
  });
  await seedExample(db, steady, 'source', 'Keep a steady hand.', { createdAt: T.t4 });

  return { gravity, wearDown, raw, steady, personalId };
}

describe('GET /api/library 列表', () => {
  it('默认隐藏 archived，按 createdAt 倒序，返回分页元信息', async () => {
    const { app, db, cookie } = await newApp();
    const ids = await seedLibrary(db);
    const res = await app.inject({ method: 'GET', url: '/api/library', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([
      ids.raw,
      ids.wearDown,
      ids.gravity,
    ]);
  });

  it('DTO 含自然语言阶段、两维最近 nextReviewAt、tags', async () => {
    const { app, db, cookie } = await newApp();
    const ids = await seedLibrary(db);
    const res = await app.inject({ method: 'GET', url: '/api/library', headers: { cookie } });
    interface ListItemJson {
      id: string;
      target: string;
      tags: string[];
      source: string | null;
      understandingStage: string;
      productionStage: string;
      nextReviewAt: string | null;
    }
    const byId = new Map<string, ListItemJson>(
      res.json().items.map((i: ListItemJson) => [i.id, i] as const),
    );
    const gravity = byId.get(ids.gravity)!;
    expect(gravity.target).toBe('gravity');
    expect(gravity.tags).toEqual(['Avatar']);
    expect(gravity.source).toBe('Avatar S01E12');
    expect(gravity.understandingStage).toBe('练习中'); // level 3
    expect(gravity.productionStage).toBe('未开始'); // level 0
    expect(gravity.nextReviewAt).toBe(T.nextU); // 仅 U 有 next

    const wear = byId.get(ids.wearDown)!;
    expect(wear.understandingStage).toBe('稳定'); // level 7 stable
    expect(wear.productionStage).toBe('初学'); // level 2
    expect(wear.nextReviewAt).toBe(T.nextP);
  });

  it('搜索覆盖 target/meaning/source/notes/tags/所有例句（大小写不敏感）', async () => {
    const { app, db, cookie } = await newApp();
    await seedLibrary(db);

    const cases: Array<[string, string[]]> = [
      ['GRAVITY', ['gravity']], // target
      ['严重性', ['gravity']], // meaning
      ['avatar', ['gravity']], // tag + source
      ['zero gravity', ['gravity']], // extra 例句
      ['situation surprised', ['gravity']], // personal 例句
      ['messy', ['raw']], // source 例句
      ['疲惫', ['wear down']], // meaning
    ];
    for (const [q, targets] of cases) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/library?query=${encodeURIComponent(q)}`,
        headers: { cookie },
      });
      expect(res.statusCode, `query=${q}`).toBe(200);
      expect(
        res.json().items.map((i: { target: string }) => i.target),
        `query=${q}`,
      ).toEqual(targets);
    }
  });

  it('LIKE 通配符被转义，不产生意外命中', async () => {
    const { app, db, cookie } = await newApp();
    await seedLibrary(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/library?query=${encodeURIComponent('g_a%')}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
  });

  it('筛选 type / status', async () => {
    const { app, db, cookie } = await newApp();
    await seedLibrary(db);

    const chunk = await app.inject({
      method: 'GET',
      url: '/api/library?type=chunk',
      headers: { cookie },
    });
    expect(chunk.json().items.map((i: { target: string }) => i.target)).toEqual(['wear down']);

    const archived = await app.inject({
      method: 'GET',
      url: '/api/library?status=archived',
      headers: { cookie },
    });
    expect(archived.json().items.map((i: { target: string }) => i.target)).toEqual(['steady']);

    const paused = await app.inject({
      method: 'GET',
      url: '/api/library?status=paused',
      headers: { cookie },
    });
    expect(paused.json().items.map((i: { target: string }) => i.target)).toEqual(['raw']);
  });

  it('分页 pageSize/page 生效', async () => {
    const { app, db, cookie } = await newApp();
    await seedLibrary(db);
    const p1 = await app.inject({
      method: 'GET',
      url: '/api/library?page=1&pageSize=2',
      headers: { cookie },
    });
    expect(p1.json().items).toHaveLength(2);
    expect(p1.json().total).toBe(3);

    const p2 = await app.inject({
      method: 'GET',
      url: '/api/library?page=2&pageSize=2',
      headers: { cookie },
    });
    expect(p2.json().items).toHaveLength(1);

    const bad = await app.inject({
      method: 'GET',
      url: '/api/library?page=0',
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('未登录返回 401', async () => {
    const { app } = await newApp();
    const res = await app.inject({ method: 'GET', url: '/api/library' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/library/:id 详情', () => {
  it('按 kind 分组例句；personal 不含 qualityScore；reviewStates 两维', async () => {
    const { app, db, cookie } = await newApp();
    const ids = await seedLibrary(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/library/${ids.gravity}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.item.id).toBe(ids.gravity);
    expect(body.item.type).toBe('word');
    expect(body.item.meaning).toBe('重力；严重性');
    expect(body.sourceExample).toBe('Gravity is a force that pulls things down.');
    expect(body.extraExamples).toEqual(['Keep a steady pace in zero gravity.']);
    expect(body.personalExamples).toHaveLength(1);
    const personal = body.personalExamples[0];
    expect(personal.id).toBe(ids.personalId);
    expect(personal.pinned).toBe(true);
    expect(personal.text).toBe('The gravity of the situation surprised me.');
    expect(personal).not.toHaveProperty('qualityScore');

    interface ReviewStateJson {
      dimension: string;
      level: number;
      stable: boolean;
      nextReviewAt: string | null;
    }
    const dims = new Map<string, ReviewStateJson>(
      body.reviewStates.map((s: ReviewStateJson) => [s.dimension, s] as const),
    );
    expect(dims.get('understanding')!.level).toBe(3);
    expect(dims.get('understanding')!.stable).toBe(false);
    expect(dims.get('understanding')!.nextReviewAt).toBe(T.nextU);
    expect(dims.get('production')!.level).toBe(0);
  });

  it('productionHistory：该 item 的 production attempts 最新 10 条倒序；PATCH 后同样返回', async () => {
    const { app, db, cookie } = await newApp();
    const ids = await seedLibrary(db);
    // wear down：1 道表达题 + 12 条历史 attempts（today 模式）
    const qid = await seedQuestion(db, ids.wearDown, {
      type: 'production',
      promptText: '请使用 wear down 造句。',
      payloadJson: JSON.stringify({
        mustUse: 'wear down',
        referenceAnswer: 'The stress wears me down.',
        acceptanceNotes: '允许变化。',
      }),
    });
    // 一道选择题（不应出现在 productionHistory）
    await seedQuestion(db, ids.wearDown, {
      type: 'understanding',
      payloadJson: JSON.stringify({
        options: [
          { id: 'o1', text: '消耗' },
          { id: 'o2', text: '支持' },
        ],
      }),
      correctOptionId: 'o1',
    });
    for (let i = 0; i < 12; i++) {
      const mode = i % 3 === 0 ? 'library_practice' : 'today';
      await db
        .insert(attempts)
        .values({
          id: `ph-a-${String(i).padStart(2, '0')}`,
          reviewTaskId: null,
          learningItemId: ids.wearDown,
          questionId: i === 5 ? null : qid,
          mode,
          answerText: `Original ${i}`,
          selectedOptionId: null,
          result: i % 2 === 0 ? 'pass' : 'fail',
          viewedSource: 0,
          feedback: null,
          correctionJson:
            i % 2 === 0
              ? JSON.stringify({
                  segments: [{ text: `Original ${i}`, type: 'same' }],
                  corrected: `Corrected ${i}`,
                  better: i === 4 ? 'Better 4' : null,
                })
              : JSON.stringify({
                  segments: [
                    { text: `Original ${i}`, type: 'delete' },
                    { text: `Corrected ${i}`, type: 'insert' },
                  ],
                  corrected: `Corrected ${i}`,
                  better: null,
                }),
          explanation: '解释',
          betterVersion: i === 4 ? 'Better 4' : null,
          aiPromptKey: 'check_production',
          aiPromptVersion: 1,
          aiPromptHash: 'hash',
          aiModel: 'mock',
          preStateJson: null,
          postStateJson: null,
          createdAt: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
          voidedAt: null,
        })
        .run();
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/library/${ids.wearDown}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = LibraryItemDetail.parse(res.json());
    expect(body.productionHistory).toHaveLength(10); // 只保留最新 10 条
    expect(body.productionHistory[0]!.id).toBe('ph-a-11');
    expect(body.productionHistory.map((h) => h.id)).not.toContain('ph-a-00');
    const first = body.productionHistory[0]!;
    expect(first).toEqual({
      id: 'ph-a-11',
      createdAt: '2026-09-21T00:00:00.000Z',
      originalText: 'Original 11',
      correctedSentence: 'Corrected 11',
      betterVersion: null,
      result: 'fail',
      mode: 'today',
    });
    const fourth = body.productionHistory.find((h) => h.id === 'ph-a-08')!;
    expect(fourth.correctedSentence).toBe('Corrected 8');

    // PATCH 响应同样携带 productionHistory
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/library/${ids.wearDown}`,
      headers: { cookie },
      payload: { notes: '更新' },
    });
    expect(patched.statusCode).toBe(200);
    expect(LibraryItemDetail.parse(patched.json()).productionHistory).toHaveLength(10);
  });

  it('无造句历史 → productionHistory 为空数组', async () => {
    const { app, db, cookie } = await newApp();
    const ids = await seedLibrary(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/library/${ids.gravity}`,
      headers: { cookie },
    });
    const body = LibraryItemDetail.parse(res.json());
    expect(body.productionHistory).toEqual([]);
  });

  it('不存在返回 404', async () => {
    const { app, cookie } = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/library/no-such-id',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /api/library/:id 编辑', () => {
  it('更新基础字段与 sourceExample；type=chunk 时 ipa 强制 null', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db, {
      type: 'word',
      target: 'gravity',
      meaning: '重力',
      ipa: 'ˈɡravəti',
    });
    await seedExample(db, id, 'source', 'old sentence');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/library/${id}`,
      headers: { cookie },
      payload: {
        meaning: '重力；地心引力',
        notes: '常用于物理语境',
        tags: ['Physics'],
        sourceExample: 'new sentence',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.item.meaning).toBe('重力；地心引力');
    expect(body.item.notes).toBe('常用于物理语境');
    expect(body.item.tags).toEqual(['Physics']);
    expect(body.sourceExample).toBe('new sentence');

    const chunk = await app.inject({
      method: 'PATCH',
      url: `/api/library/${id}`,
      headers: { cookie },
      payload: { type: 'chunk', ipa: 'should-be-ignored' },
    });
    expect(chunk.statusCode).toBe(200);
    expect(chunk.json().item.type).toBe('chunk');
    expect(chunk.json().item.ipa).toBeNull();
  });

  it('extraExamples 全量替换并按新顺序重排', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db);
    await seedExample(db, id, 'source', 'src');
    await seedExample(db, id, 'extra', 'old-1', { sortOrder: 0 });
    await seedExample(db, id, 'extra', 'old-2', { sortOrder: 1 });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/library/${id}`,
      headers: { cookie },
      payload: { extraExamples: ['new-a', 'new-b', 'new-c'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().extraExamples).toEqual(['new-a', 'new-b', 'new-c']);
  });

  it('personalExamples 仅支持改 pinned/text', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db);
    await seedExample(db, id, 'source', 'src');
    const p1 = await seedExample(db, id, 'personal', 'first sentence', { sortOrder: 0 });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/library/${id}`,
      headers: { cookie },
      payload: { personalExamples: [{ id: p1, pinned: true, text: 'better sentence' }] },
    });
    expect(res.statusCode).toBe(200);
    const personal = res.json().personalExamples[0];
    expect(personal.pinned).toBe(true);
    expect(personal.text).toBe('better sentence');

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/library/${id}`,
      headers: { cookie },
      payload: { personalExamples: [{ id: 'no-such-example', pinned: true }] },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('仅改 notes 等非清题字段不触发清题', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db, { target: 'gravity', meaning: '重力' });
    await seedExample(db, id, 'source', 'src');
    await seedQuestion(db, id, { status: 'fresh' });
    await seedQuestion(db, id, { status: 'active' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/library/${id}`,
      headers: { cookie },
      payload: { notes: 'just a note' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().progressResetSuggested).toBe(false);

    const rows = await db.select().from(questions).where(eq(questions.learningItemId, id));
    expect(rows.filter((q) => q.status === 'fresh')).toHaveLength(1);
    expect(rows.filter((q) => q.status === 'active')).toHaveLength(1);
  });

  it('target 变化使 fresh/active 题全部 retired，progressResetSuggested=false', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db, { target: 'gravity', meaning: '重力' });
    await seedExample(db, id, 'source', 'src');
    await seedQuestion(db, id, { status: 'fresh' });
    await seedQuestion(db, id, { status: 'fresh' });
    const oldRetired = '2026-08-01T00:00:00.000Z';
    const retiredId = await seedQuestion(db, id, { status: 'retired', retiredAt: oldRetired });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/library/${id}`,
      headers: { cookie },
      payload: { target: 'GRAVITY' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().progressResetSuggested).toBe(false);

    const rows = await db.select().from(questions).where(eq(questions.learningItemId, id));
    expect(rows.filter((q) => q.status === 'fresh')).toHaveLength(0);
    expect(rows.filter((q) => q.status === 'retired')).toHaveLength(3);
    // 原 retired 题的 retired_at 不被改写，新 retired 题写入 retired_at
    expect(rows.find((q) => q.id === retiredId)?.retiredAt).toBe(oldRetired);
    const newlyRetired = rows.filter((q) => q.id !== retiredId);
    expect(newlyRetired.every((q) => q.retiredAt !== null)).toBe(true);
  });

  it('meaning 变化清题且 progressResetSuggested=true', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db, { target: 'gravity', meaning: '重力' });
    await seedExample(db, id, 'source', 'src');
    await seedQuestion(db, id, { status: 'fresh' });
    await seedQuestion(db, id, { status: 'active' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/library/${id}`,
      headers: { cookie },
      payload: { meaning: '严重性；严肃' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().progressResetSuggested).toBe(true);

    const rows = await db.select().from(questions).where(eq(questions.learningItemId, id));
    expect(rows.every((q) => q.status === 'retired')).toBe(true);
    expect(rows.every((q) => q.retiredAt !== null)).toBe(true);
  });

  it('target/meaning 传相同值不触发清题', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db, { target: 'gravity', meaning: '重力' });
    await seedExample(db, id, 'source', 'src');
    await seedQuestion(db, id, { status: 'fresh' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/library/${id}`,
      headers: { cookie },
      payload: { target: 'gravity', meaning: '重力' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().progressResetSuggested).toBe(false);
    const rows = await db.select().from(questions).where(eq(questions.learningItemId, id));
    expect(rows[0]!.status).toBe('fresh');
  });

  it('不存在的 item 返回 404', async () => {
    const { app, cookie } = await newApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/library/no-such-id',
      headers: { cookie },
      payload: { notes: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('状态操作端点', () => {
  it('pause / resume 切换 status', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db, { status: 'active' });
    await seedExample(db, id, 'source', 'Some sentence.');

    const paused = await app.inject({
      method: 'POST',
      url: `/api/library/${id}/pause`,
      headers: { cookie },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().item.status).toBe('paused');

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/library/${id}/resume`,
      headers: { cookie },
    });
    expect(resumed.json().item.status).toBe('active');
  });

  it('archive 写入 archivedAt，restore 清除并回到 active', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db, { status: 'paused' });
    await seedExample(db, id, 'source', 'Some sentence.');

    const archived = await app.inject({
      method: 'POST',
      url: `/api/library/${id}/archive`,
      headers: { cookie },
    });
    expect(archived.json().item.status).toBe('archived');
    expect(archived.json().item.archivedAt).toBeTruthy();

    const restored = await app.inject({
      method: 'POST',
      url: `/api/library/${id}/restore`,
      headers: { cookie },
    });
    expect(restored.json().item.status).toBe('active');
    expect(restored.json().item.archivedAt).toBeNull();
  });

  it('reset：两维归零、status=active、queue_state=new、needs_reinforcement=0', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db, {
      status: 'paused',
      queueState: 'started',
      needsReinforcement: 1,
    });
    await seedExample(db, id, 'source', 'Some sentence.');
    await seedReviewState(db, id, 'understanding', {
      level: 5,
      stable: 1,
      nextReviewAt: T.nextU,
      lastReviewAt: T.t1,
      correctStreak: 3,
      wrongStreak: 1,
    });
    await seedReviewState(db, id, 'production', {
      level: 4,
      nextReviewAt: T.nextP,
      correctStreak: 2,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/library/${id}/reset`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.item.status).toBe('active');
    expect(body.item.queueState).toBe('new');
    expect(body.item.needsReinforcement).toBe(false);
    for (const state of body.reviewStates) {
      expect(state.level).toBe(0);
      expect(state.stable).toBe(false);
      expect(state.nextReviewAt).toBeNull();
      expect(state.lastReviewAt).toBeNull();
    }
  });

  it('master：两维 stable + level 7，status=mastered', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db, { status: 'active' });
    await seedExample(db, id, 'source', 'Some sentence.');
    await seedReviewState(db, id, 'understanding', { level: 6 });
    await seedReviewState(db, id, 'production', { level: 2 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/library/${id}/master`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.item.status).toBe('mastered');
    for (const state of body.reviewStates) {
      expect(state.stable).toBe(true);
      expect(state.level).toBe(7);
    }
  });

  it('不存在的 item 状态操作返回 404', async () => {
    const { app, cookie } = await newApp();
    for (const action of ['pause', 'resume', 'archive', 'restore', 'reset', 'master']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/library/no-such-id/${action}`,
        headers: { cookie },
      });
      expect(res.statusCode, action).toBe(404);
    }
  });
});
