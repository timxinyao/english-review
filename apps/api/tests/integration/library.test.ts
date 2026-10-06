import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { LibraryItemDetail, localDateString } from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import {
  attempts,
  dailyStats,
  learningItems,
  questions,
  reviewSessions,
  reviewStates,
  reviewTasks,
} from '../../src/db/schema.js';
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
  await seedReviewState(db, gravity, 'understanding', {
    difficulty: 5,
    stability: 15,
    reps: 3,
    nextReviewAt: T.nextU,
    lastReviewAt: '2026-09-20T00:00:00.000Z',
  });
  await seedReviewState(db, gravity, 'production', { difficulty: null, stability: null, reps: 0 });

  const wearDown = await seedItem(db, {
    type: 'chunk',
    target: 'wear down',
    meaning: '逐渐使疲惫；消耗',
    createdAt: T.t2,
    updatedAt: T.t2,
  });
  await seedExample(db, wearDown, 'source', 'It wears you down.', { createdAt: T.t2 });
  await seedReviewState(db, wearDown, 'understanding', { difficulty: 5, stability: 130, reps: 8 });
  await seedReviewState(db, wearDown, 'production', {
    difficulty: 5,
    stability: 5,
    reps: 2,
    nextReviewAt: T.nextP,
    lastReviewAt: '2026-09-20T00:00:00.000Z',
  });

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

describe('PATCH /api/library/:id 造句目标', () => {
  it('三态覆盖与类型默认值：true、false、null，保留 U 和 P 历史', async () => {
    const { app, db, cookie } = await newApp();
    const { gravity } = await seedLibrary(db);
    const beforeU = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, gravity))
      .all()
      .find((s) => s.dimension === 'understanding');
    for (const [value, expected] of [
      [true, true],
      [false, false],
      [null, false],
    ] as const) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/library/${gravity}`,
        headers: { cookie },
        payload: { productionEnabledOverride: value },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().item.productionEnabledOverride).toBe(value);
      expect(res.json().item.productionEnabled).toBe(expected);
    }
    const typeChange = await app.inject({
      method: 'PATCH',
      url: `/api/library/${gravity}`,
      headers: { cookie },
      payload: { type: 'chunk', productionEnabledOverride: null },
    });
    expect(typeChange.statusCode).toBe(200);
    expect(typeChange.json().item.productionEnabled).toBe(true);
    expect(
      db
        .select()
        .from(reviewStates)
        .where(eq(reviewStates.learningItemId, gravity))
        .all()
        .find((s) => s.dimension === 'understanding'),
    ).toEqual(beforeU);
  });

  it('开启目标使已掌握词条 active，未激活 P 从 L0 排到下一日；暂停/归档不恢复', async () => {
    const { app, db, cookie } = await newApp();
    const ids = await seedLibrary(db);
    db.update(learningItems)
      .set({ status: 'mastered', queueState: 'started' })
      .where(eq(learningItems.id, ids.gravity))
      .run();
    db.update(reviewStates)
      .set({ difficulty: 5, stability: 130, nextReviewAt: null })
      .where(
        and(
          eq(reviewStates.learningItemId, ids.gravity),
          eq(reviewStates.dimension, 'understanding'),
        ),
      )
      .run();
    db.update(reviewStates)
      .set({ difficulty: null, stability: null, reps: 0, lapses: 0, nextReviewAt: null })
      .where(
        and(eq(reviewStates.learningItemId, ids.gravity), eq(reviewStates.dimension, 'production')),
      )
      .run();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/library/${ids.gravity}`,
      headers: { cookie },
      payload: { productionEnabledOverride: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.status).toBe('active');
    const p = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, ids.gravity))
      .all()
      .find((s) => s.dimension === 'production')!;
    expect(p.stability).toBeNull();
    expect(p.nextReviewAt).not.toBeNull();
    expect(Date.parse(p.nextReviewAt!)).toBeGreaterThan(Date.now());
    expect(Date.parse(p.nextReviewAt!)).toBeLessThanOrEqual(Date.now() + 86_400_000 + 5_000);
    for (const id of [ids.raw, ids.steady]) {
      const edited = await app.inject({
        method: 'PATCH',
        url: `/api/library/${id}`,
        headers: { cookie },
        payload: { productionEnabledOverride: true },
      });
      expect(edited.statusCode).toBe(200);
    }
    expect(db.select().from(learningItems).where(eq(learningItems.id, ids.raw)).get()?.status).toBe(
      'paused',
    );
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, ids.steady)).get()?.status,
    ).toBe('archived');
  });

  it('本地日 23:50 开启时排到次日 00:00，且不插入当天已有 Session', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db, { type: 'word', queueState: 'started' });
    await seedExample(db, id, 'source', 'A source sentence.');
    const now = '2026-09-30T15:50:00.000Z'; // Asia/Shanghai 23:50
    db.insert(reviewSessions)
      .values({
        id: 'evening-session',
        sessionDate: '2026-09-30',
        startedAt: now,
        completedAt: now,
        baseTaskCount: 0,
        newItemsStarted: 0,
        createdAt: now,
      })
      .run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/library/${id}`,
        headers: { cookie },
        payload: { productionEnabledOverride: true },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    const p = db.select().from(reviewStates).where(eq(reviewStates.learningItemId, id)).get();
    expect(p?.stability).toBeNull();
    expect(p?.nextReviewAt).toBe('2026-09-30T16:00:00.000Z');
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.sessionId, 'evening-session')).all(),
    ).toHaveLength(0);
  });

  it('关闭 P 只取消当日未答 P，进度完成；已答题、attempt 和统计不变，旧设备提交 409', async () => {
    const { app, db, cookie } = await newApp();
    const ids = await seedLibrary(db);
    const date = localDateString(new Date(), 'Asia/Shanghai');
    const now = new Date().toISOString();
    db.insert(reviewSessions)
      .values({
        id: 'goal-session',
        sessionDate: date,
        startedAt: now,
        completedAt: null,
        baseTaskCount: 3,
        newItemsStarted: 0,
        createdAt: now,
      })
      .run();
    const task = (id: string, itemId: string, dimension: string, completedAt: string | null) => ({
      id,
      sessionId: 'goal-session',
      learningItemId: itemId,
      dimension,
      questionId: null,
      taskType: dimension === 'production' ? 'production' : 'understanding',
      origin: 'base',
      sortKey: id === 'pending-p' ? 3 : id === 'answered-p' ? 1 : 2,
      deferCount: 0,
      completedAt,
      canceledAt: null,
      createdAt: now,
    });
    db.insert(reviewTasks)
      .values([
        task('answered-p', ids.wearDown, 'production', now),
        task('answered-u', ids.wearDown, 'understanding', now),
        task('pending-p', ids.wearDown, 'production', null),
      ])
      .run();
    db.insert(dailyStats)
      .values({
        date,
        formalTasksCompleted: 2,
        newItemsStarted: 0,
        productionAttempts: 1,
        productionPass: 1,
        updatedAt: now,
      })
      .run();
    const answeredQuestion = await seedQuestion(db, ids.wearDown, { type: 'production' });
    db.update(reviewTasks)
      .set({ questionId: answeredQuestion })
      .where(eq(reviewTasks.id, 'answered-p'))
      .run();
    db.insert(attempts)
      .values({
        id: 'answered-attempt',
        reviewTaskId: 'answered-p',
        learningItemId: ids.wearDown,
        questionId: answeredQuestion,
        mode: 'today',
        answerText: 'It wore me down.',
        result: 'pass',
        createdAt: now,
      })
      .run();
    const priorP = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, ids.wearDown))
      .all()
      .find((s) => s.dimension === 'production');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/library/${ids.wearDown}`,
      headers: { cookie },
      payload: { productionEnabledOverride: false },
    });
    expect(res.statusCode).toBe(200);
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.id, 'pending-p')).get()?.canceledAt,
    ).not.toBeNull();
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.id, 'answered-p')).get()?.canceledAt,
    ).toBeNull();
    expect(
      db.select().from(reviewSessions).where(eq(reviewSessions.id, 'goal-session')).get()
        ?.completedAt,
    ).not.toBeNull();
    expect(
      db.select().from(dailyStats).where(eq(dailyStats.date, date)).get()?.formalTasksCompleted,
    ).toBe(2);
    expect(
      db.select().from(attempts).where(eq(attempts.id, 'answered-attempt')).get()?.result,
    ).toBe('pass');
    expect(
      db
        .select()
        .from(reviewStates)
        .where(eq(reviewStates.learningItemId, ids.wearDown))
        .all()
        .find((s) => s.dimension === 'production'),
    ).toEqual(priorP);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/today/tasks/pending-p/answer',
      headers: { cookie },
      payload: { answerText: 'Anything.' },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      db.select().from(attempts).where(eq(attempts.reviewTaskId, 'pending-p')).all(),
    ).toHaveLength(0);
    const onAgain = await app.inject({
      method: 'PATCH',
      url: `/api/library/${ids.wearDown}`,
      headers: { cookie },
      payload: { productionEnabledOverride: true },
    });
    expect(onAgain.statusCode).toBe(200);
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.sessionId, 'goal-session')).all(),
    ).toHaveLength(3);
    expect(
      db.select().from(reviewTasks).where(eq(reviewTasks.id, 'pending-p')).get()?.canceledAt,
    ).not.toBeNull();
  });
});

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
    expect(gravity.understandingStage).toBe('巩固'); // S15（7≤S<30）
    expect(gravity.productionStage).toBe('未开始'); // 未激活
    expect(gravity.nextReviewAt).toBe(T.nextU); // 仅 U 有 next

    const wear = byId.get(ids.wearDown)!;
    expect(wear.understandingStage).toBe('掌握'); // S130
    expect(wear.productionStage).toBe('新'); // S5
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
      difficulty: number | null;
      stability: number | null;
      nextReviewAt: string | null;
    }
    const dims = new Map<string, ReviewStateJson>(
      body.reviewStates.map((s: ReviewStateJson) => [s.dimension, s] as const),
    );
    expect(dims.get('understanding')!.difficulty).toBe(5);
    expect(dims.get('understanding')!.stability).toBe(15);
    expect(dims.get('understanding')!.nextReviewAt).toBe(T.nextU);
    expect(dims.get('production')!.stability).toBeNull();
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
      betterVersionKind: null,
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
      difficulty: 5,
      stability: 130,
      reps: 5,
      nextReviewAt: T.nextU,
      lastReviewAt: T.t1,
      correctStreak: 3,
      wrongStreak: 1,
    });
    await seedReviewState(db, id, 'production', {
      difficulty: 5,
      stability: 25,
      reps: 4,
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
      expect(state.difficulty).toBeNull();
      expect(state.stability).toBeNull();
      expect(state.nextReviewAt).toBeNull();
      expect(state.lastReviewAt).toBeNull();
    }
  });

  it('master：两维 stability 置于掌握线（S=120），status=mastered', async () => {
    const { app, db, cookie } = await newApp();
    const id = await seedItem(db, { status: 'active' });
    await seedExample(db, id, 'source', 'Some sentence.');
    await seedReviewState(db, id, 'understanding', { difficulty: 5, stability: 70, reps: 6 });
    await seedReviewState(db, id, 'production', { difficulty: 5, stability: 5, reps: 2 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/library/${id}/master`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.item.status).toBe('mastered');
    for (const state of body.reviewStates) {
      expect(state.stability).toBe(120);
      expect(state.difficulty).toBe(5);
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
