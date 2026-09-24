import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../../src/db/client.js';
import { learningExamples, learningItems, reviewStates } from '../../src/db/schema.js';
import { createTestApp, loginCookie, type TestApp } from '../helpers/test-app.js';
import { seedExample, seedItem, seedReviewState } from '../helpers/seed.js';
import { previewImport, type DuplicateJudge } from '../../src/modules/import-export/service.js';

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

async function seedWearDown(db: AppDatabase): Promise<string> {
  const id = await seedItem(db, {
    type: 'chunk',
    target: 'wear down',
    meaning: '逐渐使疲惫；消耗',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  await seedExample(db, id, 'source', 'It wears you down.', {
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  return id;
}

function importPayload(items: Array<Record<string, unknown>>): {
  version: '1.2';
  items: Array<Record<string, unknown>>;
} {
  return { version: '1.2', items };
}

describe('POST /api/import/preview（HTTP，无 GLM key → 规则路径）', () => {
  it('完全重复（归一化后 target+meaning+source_example 相同）→ rule_exact skip_exact_duplicate', async () => {
    const { app, db, cookie } = await newApp();
    await seedWearDown(db);

    const res = await app.inject({
      method: 'POST',
      url: '/api/import/preview',
      headers: { cookie },
      payload: importPayload([
        {
          type: 'chunk',
          target: '  Wear  DOWN.', // 归一化后与库内一致
          meaning: '逐渐使疲惫；消耗',
          source_example: 'it wears you down.', // 大小写不同
          extra_examples: [],
          tags: [],
        },
      ]),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.previewToken).toBe('string');
    const item = body.items[0];
    expect(item.index).toBe(0);
    expect(item.suggestion.action).toBe('skip_exact_duplicate');
    expect(item.suggestion.source).toBe('rule_exact');
    expect(item.suggestion.confidence).toBe(1);
    expect(item.match.existingTarget).toBe('wear down');
    expect(item.match.existingMeaning).toBe('逐渐使疲惫；消耗');
  });

  it('同 target 但非完全重复且无 key → merge 规则回退（source=rule_fallback, confidence=0.5）', async () => {
    const { app, db, cookie } = await newApp();
    await seedWearDown(db);

    const res = await app.inject({
      method: 'POST',
      url: '/api/import/preview',
      headers: { cookie },
      payload: importPayload([
        {
          type: 'chunk',
          target: 'wear down',
          meaning: '磨损；使渐渐损坏',
          source_example: 'The stairs were worn down by years of use.',
          extra_examples: [],
          tags: [],
        },
      ]),
    });
    expect(res.statusCode).toBe(200);
    const item = res.json().items[0];
    expect(item.suggestion.action).toBe('merge');
    expect(item.suggestion.source).toBe('rule_fallback');
    expect(item.suggestion.confidence).toBe(0.5);
    expect(item.suggestion.reason).toContain('AI');
    expect(item.match.existingId).toBeTruthy();
  });

  it('无同 target 匹配 → new_item（rule_fallback, confidence=1, match=null）', async () => {
    const { app, db, cookie } = await newApp();
    await seedWearDown(db);

    const res = await app.inject({
      method: 'POST',
      url: '/api/import/preview',
      headers: { cookie },
      payload: importPayload([
        {
          type: 'word',
          target: 'gravity',
          meaning: '重力',
          source_example: 'Gravity pulls things down.',
          extra_examples: [],
          tags: [],
        },
      ]),
    });
    expect(res.statusCode).toBe(200);
    const item = res.json().items[0];
    expect(item.suggestion.action).toBe('new_item');
    expect(item.suggestion.source).toBe('rule_fallback');
    expect(item.suggestion.confidence).toBe(1);
    expect(item.match).toBeNull();
  });

  it('非法 body（version 错误 / 缺 source_example）→ 400 VALIDATION_ERROR', async () => {
    const { app, cookie } = await newApp();
    const badVersion = await app.inject({
      method: 'POST',
      url: '/api/import/preview',
      headers: { cookie },
      payload: {
        version: '1.0',
        items: [{ type: 'word', target: 'a', meaning: 'b', source_example: 'c' }],
      },
    });
    expect(badVersion.statusCode).toBe(400);
    expect(badVersion.json().error.code).toBe('VALIDATION_ERROR');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/import/preview',
      headers: { cookie },
      payload: importPayload([{ type: 'word', target: 'a', meaning: 'b' }]),
    });
    expect(missing.statusCode).toBe(400);
  });

  it('未登录返回 401', async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/preview',
      payload: importPayload([{ type: 'word', target: 'a', meaning: 'b', source_example: 'c' }]),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('previewImport（service 级，judge 注入）', () => {
  const noMatchCandidate = {
    type: 'word',
    target: 'gravity',
    meaning: '重力',
    source_example: 'Gravity pulls.',
    extra_examples: [] as string[],
    tags: [] as string[],
  } satisfies { type: 'word' | 'chunk' } & Record<string, unknown>;

  it('AI 判定 new_item 时透传（source=ai，confidence/reason 透传）', async () => {
    const { db } = await newApp();
    await seedWearDown(db);
    const judge: DuplicateJudge = async () => ({
      decision: 'new_item',
      confidence: 0.87,
      reason: '同 target 但一个指体力消耗、一个指机械磨损，义项明显不同。',
    });

    const res = await previewImport(
      { db, judge },
      {
        version: '1.2',
        items: [
          {
            type: 'chunk',
            target: 'wear down',
            meaning: '磨损；使渐渐损坏',
            source_example: 'The stairs were worn down.',
            extra_examples: [],
            tags: [],
          },
        ],
      },
    );
    const item = res.items[0]!;
    expect(item.suggestion.action).toBe('new_item');
    expect(item.suggestion.source).toBe('ai');
    expect(item.suggestion.confidence).toBe(0.87);
    expect(item.suggestion.reason).toContain('义项明显不同');
    expect(item.match).not.toBeNull();
  });

  it('AI 调用抛错 → 规则回退 merge（rule_fallback）', async () => {
    const { db } = await newApp();
    await seedWearDown(db);
    const judge: DuplicateJudge = async () => {
      throw new Error('glm unavailable');
    };

    const res = await previewImport(
      { db, judge },
      {
        version: '1.2',
        items: [
          {
            type: 'chunk',
            target: 'wear down',
            meaning: '磨损',
            source_example: 'Worn down stairs.',
            extra_examples: [],
            tags: [],
          },
        ],
      },
    );
    expect(res.items[0]!.suggestion.action).toBe('merge');
    expect(res.items[0]!.suggestion.source).toBe('rule_fallback');
  });

  it('AI 返回 null（无 key）→ 规则回退 merge', async () => {
    const { db } = await newApp();
    await seedWearDown(db);
    const judge: DuplicateJudge = async () => null;

    const res = await previewImport(
      { db, judge },
      {
        version: '1.2',
        items: [
          {
            type: 'chunk',
            target: 'wear down',
            meaning: '磨损',
            source_example: 'Worn down stairs.',
            extra_examples: [],
            tags: [],
          },
        ],
      },
    );
    expect(res.items[0]!.suggestion.action).toBe('merge');
    expect(res.items[0]!.suggestion.source).toBe('rule_fallback');
  });

  it('无匹配项不调用 judge', async () => {
    const { db } = await newApp();
    let called = 0;
    const judge: DuplicateJudge = async () => {
      called++;
      return null;
    };
    await previewImport({ db, judge }, { version: '1.2', items: [noMatchCandidate] });
    expect(called).toBe(0);
  });
});

describe('POST /api/import/commit', () => {
  async function previewAndCommit(
    ctx: TestApp & { cookie: string },
    items: Array<Record<string, unknown>>,
    decisions: Array<{ index: number; action: string }>,
  ) {
    const preview = await ctx.app.inject({
      method: 'POST',
      url: '/api/import/preview',
      headers: { cookie: ctx.cookie },
      payload: importPayload(items),
    });
    expect(preview.statusCode).toBe(200);
    const token = preview.json().previewToken as string;
    return ctx.app.inject({
      method: 'POST',
      url: '/api/import/commit',
      headers: { cookie: ctx.cookie },
      payload: { previewToken: token, decisions },
    });
  }

  it('new_item 创建 Item+source/extra 例句，queue_state=new，review_states 两行归零', async () => {
    const ctx = await newApp();
    const res = await previewAndCommit(
      ctx,
      [
        {
          type: 'word',
          target: 'gravity',
          meaning: '重力',
          ipa: 'ˈɡravəti',
          source_example: 'Gravity pulls things down.',
          extra_examples: ['Zero gravity is fun.', 'Gravity varies.'],
          source: 'Physics 101',
          tags: ['Physics'],
          notes: '基础词',
        },
      ],
      [{ index: 0, action: 'new_item' }],
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: 1, merged: 0, skipped: 0, total: 1 });

    const [item] = await ctx.db
      .select()
      .from(learningItems)
      .where(eq(learningItems.target, 'gravity'));
    expect(item).toBeTruthy();
    expect(item!.status).toBe('active');
    expect(item!.queueState).toBe('new');
    expect(item!.ipa).toBe('ˈɡravəti');
    expect(item!.source).toBe('Physics 101');
    expect(JSON.parse(item!.tagsJson)).toEqual(['Physics']);
    expect(item!.notes).toBe('基础词');

    const examples = await ctx.db
      .select()
      .from(learningExamples)
      .where(eq(learningExamples.learningItemId, item!.id));
    expect(examples.filter((e) => e.kind === 'source').map((e) => e.text)).toEqual([
      'Gravity pulls things down.',
    ]);
    const extras = examples
      .filter((e) => e.kind === 'extra')
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(extras.map((e) => e.text)).toEqual(['Zero gravity is fun.', 'Gravity varies.']);
    expect(extras.map((e) => e.sortOrder)).toEqual([0, 1]);

    const states = await ctx.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, item!.id));
    expect(states).toHaveLength(2);
    for (const s of states) {
      expect(s.level).toBe(0);
      expect(s.stable).toBe(0);
      expect(s.nextReviewAt).toBeNull();
    }
  });

  it('chunk 候选即使带 ipa 也强制 null', async () => {
    const ctx = await newApp();
    const res = await previewAndCommit(
      ctx,
      [
        {
          type: 'chunk',
          target: 'make sense',
          meaning: '讲得通',
          ipa: 'ignored',
          source_example: 'That makes sense.',
        },
      ],
      [{ index: 0, action: 'new_item' }],
    );
    expect(res.statusCode).toBe(200);
    const [item] = await ctx.db
      .select()
      .from(learningItems)
      .where(eq(learningItems.target, 'make sense'));
    expect(item!.ipa).toBeNull();
  });

  it('merge 不重置进度、追加去重例句、tags 并集、空字段填充', async () => {
    const ctx = await newApp();
    const id = await seedItem(ctx.db, {
      type: 'chunk',
      target: 'wear down',
      meaning: '逐渐使疲惫；消耗',
      tagsJson: '["Avatar"]',
      source: null,
      sourceUrl: null,
      notes: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await seedExample(ctx.db, id, 'source', 'It wears you down.', {
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await seedExample(ctx.db, id, 'extra', 'Existing extra.', { sortOrder: 0 });
    await seedReviewState(ctx.db, id, 'understanding', {
      level: 4,
      nextReviewAt: '2026-09-20T00:00:00.000Z',
      lastReviewAt: '2026-09-10T00:00:00.000Z',
      correctStreak: 2,
    });
    await seedReviewState(ctx.db, id, 'production', { level: 1 });

    // decisions 为空在 schema 层即拒绝（min(1)）
    const emptyDecisions = await previewAndCommit(
      ctx,
      [
        {
          type: 'chunk',
          target: 'wear down',
          meaning: '磨损；使渐渐损坏',
          source_example: 'The stairs were worn down by years of use.',
          extra_examples: [],
          tags: [],
        },
      ],
      [],
    );
    expect(emptyDecisions.statusCode).toBe(400);

    const ok = await previewAndCommit(
      ctx,
      [
        {
          type: 'chunk',
          target: 'wear down',
          meaning: '磨损；使渐渐损坏',
          source_example: 'The stairs were worn down by years of use.',
          extra_examples: ['It wears you down.', 'Brand new extra.'],
          source: 'Home Renovation',
          tags: ['Avatar', 'House'],
          notes: '机械磨损义项素材',
        },
      ],
      [{ index: 0, action: 'merge' }],
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ created: 0, merged: 1, skipped: 0, total: 1 });

    // 进度不动
    const states = await ctx.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, id));
    const u = states.find((s) => s.dimension === 'understanding')!;
    expect(u.level).toBe(4);
    expect(u.nextReviewAt).toBe('2026-09-20T00:00:00.000Z');
    expect(u.lastReviewAt).toBe('2026-09-10T00:00:00.000Z');
    expect(u.correctStreak).toBe(2);

    // source 保留，候选 source_example 追加为 extra；重复文本不追加
    const examples = await ctx.db
      .select()
      .from(learningExamples)
      .where(eq(learningExamples.learningItemId, id));
    expect(examples.filter((e) => e.kind === 'source').map((e) => e.text)).toEqual([
      'It wears you down.',
    ]);
    const extras = examples
      .filter((e) => e.kind === 'extra')
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((e) => e.text);
    expect(extras).toContain('Existing extra.');
    expect(extras).toContain('The stairs were worn down by years of use.');
    expect(extras).toContain('Brand new extra.');
    // 'It wears you down.' 不重复追加
    expect(extras.filter((t) => t === 'It wears you down.')).toHaveLength(0);

    // tags 并集；source 填充；meaning 不被覆盖
    const [item] = await ctx.db.select().from(learningItems).where(eq(learningItems.id, id));
    expect(JSON.parse(item!.tagsJson)).toEqual(['Avatar', 'House']);
    expect(item!.source).toBe('Home Renovation');
    expect(item!.notes).toBe('机械磨损义项素材');
    expect(item!.meaning).toBe('逐渐使疲惫；消耗'); // merge 不改 meaning
  });

  it('skip 计数；decision 覆盖（建议 merge → 用户改 skip 生效）', async () => {
    const ctx = await newApp();
    await seedWearDown(ctx.db);
    const res = await previewAndCommit(
      ctx,
      [
        {
          type: 'chunk',
          target: 'wear down',
          meaning: '磨损',
          source_example: 'Worn down stairs.',
          extra_examples: [],
          tags: [],
        },
      ],
      [{ index: 0, action: 'skip_exact_duplicate' }],
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: 0, merged: 0, skipped: 1, total: 1 });
    // 库内仍只有 1 条 wear down
    const rows = await ctx.db
      .select()
      .from(learningItems)
      .where(eq(learningItems.target, 'wear down'));
    expect(rows).toHaveLength(1);
  });

  it('决策未覆盖的条目沿用系统建议；混合统计正确', async () => {
    const ctx = await newApp();
    await seedWearDown(ctx.db);
    const res = await previewAndCommit(
      ctx,
      [
        {
          type: 'chunk',
          target: 'wear down',
          meaning: '磨损',
          source_example: 'Worn down stairs.',
          extra_examples: [],
          tags: [],
        },
        {
          type: 'word',
          target: 'gravity',
          meaning: '重力',
          source_example: 'Gravity pulls.',
          extra_examples: [],
          tags: [],
        },
      ],
      [{ index: 0, action: 'skip_exact_duplicate' }], // 只覆盖第 0 条；第 1 条沿用 new_item 建议
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: 1, merged: 0, skipped: 1, total: 2 });
    const gravity = await ctx.db
      .select()
      .from(learningItems)
      .where(eq(learningItems.target, 'gravity'));
    expect(gravity).toHaveLength(1);
  });

  it('token 一次性：复用已消费的 token → 404 NOT_FOUND', async () => {
    const ctx = await newApp();
    const preview = await ctx.app.inject({
      method: 'POST',
      url: '/api/import/preview',
      headers: { cookie: ctx.cookie },
      payload: importPayload([
        { type: 'word', target: 'gravity', meaning: '重力', source_example: 'Gravity pulls.' },
      ]),
    });
    const token = preview.json().previewToken;
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/import/commit',
      headers: { cookie: ctx.cookie },
      payload: { previewToken: token, decisions: [{ index: 0, action: 'new_item' }] },
    });
    expect(first.statusCode).toBe(200);

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/import/commit',
      headers: { cookie: ctx.cookie },
      payload: { previewToken: token, decisions: [{ index: 0, action: 'new_item' }] },
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.code).toBe('NOT_FOUND');
    expect(second.json().error.message).toContain('预览已过期');
    // 没有重复入库
    const rows = await ctx.db
      .select()
      .from(learningItems)
      .where(eq(learningItems.target, 'gravity'));
    expect(rows).toHaveLength(1);
  });

  it('不存在的 token → 404；decisions 为空 → 400', async () => {
    const ctx = await newApp();
    const noToken = await ctx.app.inject({
      method: 'POST',
      url: '/api/import/commit',
      headers: { cookie: ctx.cookie },
      payload: { previewToken: 'never-issued', decisions: [{ index: 0, action: 'new_item' }] },
    });
    expect(noToken.statusCode).toBe(404);

    const preview = await ctx.app.inject({
      method: 'POST',
      url: '/api/import/preview',
      headers: { cookie: ctx.cookie },
      payload: importPayload([
        { type: 'word', target: 'gravity', meaning: '重力', source_example: 'Gravity pulls.' },
      ]),
    });
    const empty = await ctx.app.inject({
      method: 'POST',
      url: '/api/import/commit',
      headers: { cookie: ctx.cookie },
      payload: { previewToken: preview.json().previewToken, decisions: [] },
    });
    expect(empty.statusCode).toBe(400);
  });
});

describe('GET /api/export/library', () => {
  it('导出非 archived 项；含 extra/personal（corrected 文本）例句与全部字段；attachment 头', async () => {
    const ctx = await newApp();
    const t1 = '2026-09-01T00:00:00.000Z';
    const gravity = await seedItem(ctx.db, {
      type: 'word',
      target: 'gravity',
      meaning: '重力；严重性',
      ipa: 'ˈɡravəti',
      source: 'Avatar S01E12',
      sourceUrl: 'https://example.com/avatar',
      tagsJson: '["Avatar"]',
      notes: '物理与比喻双义',
      createdAt: t1,
      updatedAt: t1,
    });
    await seedExample(ctx.db, gravity, 'source', 'Gravity is a force.', { createdAt: t1 });
    await seedExample(ctx.db, gravity, 'extra', 'Zero gravity again.', {
      sortOrder: 0,
      createdAt: t1,
    });
    await seedExample(ctx.db, gravity, 'personal', 'The gravity of it surprised me.', {
      originalText: 'the gravity of it surprise me',
      qualityScore: 0.9,
      sortOrder: 0,
      createdAt: t1,
    });
    const archived = await seedItem(ctx.db, {
      type: 'word',
      target: 'old-word',
      meaning: '旧词',
      status: 'archived',
      createdAt: '2026-09-02T00:00:00.000Z',
    });
    await seedExample(ctx.db, archived, 'source', 'Old sentence.', {
      createdAt: '2026-09-02T00:00:00.000Z',
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/export/library',
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="library-.*\.json"$/);

    const body = res.json();
    expect(body.version).toBe('1.2');
    expect(body.items).toHaveLength(1); // archived 被排除
    const item = body.items[0];
    expect(item.type).toBe('word');
    expect(item.target).toBe('gravity');
    expect(item.ipa).toBe('ˈɡravəti');
    expect(item.source_example).toBe('Gravity is a force.');
    expect(item.extra_examples).toEqual(['Zero gravity again.', 'The gravity of it surprised me.']);
    expect(item.source).toBe('Avatar S01E12');
    expect(item.source_url).toBe('https://example.com/avatar');
    expect(item.tags).toEqual(['Avatar']);
    expect(item.notes).toBe('物理与比喻双义');
  });

  it('未登录返回 401', async () => {
    const { app } = await newApp();
    const res = await app.inject({ method: 'GET', url: '/api/export/library' });
    expect(res.statusCode).toBe(401);
  });

  it('round-trip：导出 JSON 再 preview，同义项建议 skip/merge 而非重复新建', async () => {
    const ctx = await newApp();
    const t1 = '2026-09-01T00:00:00.000Z';
    const gravity = await seedItem(ctx.db, {
      type: 'word',
      target: 'gravity',
      meaning: '重力；严重性',
      createdAt: t1,
      updatedAt: t1,
    });
    await seedExample(ctx.db, gravity, 'source', 'Gravity is a force.', { createdAt: t1 });
    const wearDown = await seedWearDown(ctx.db);

    const exported = await ctx.app.inject({
      method: 'GET',
      url: '/api/export/library',
      headers: { cookie: ctx.cookie },
    });
    const payload = exported.json();

    const preview = await ctx.app.inject({
      method: 'POST',
      url: '/api/import/preview',
      headers: { cookie: ctx.cookie },
      payload,
    });
    expect(preview.statusCode).toBe(200);
    const items = preview.json().items as Array<{
      suggestion: { action: string };
      match: { existingId: string } | null;
    }>;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.suggestion.action).not.toBe('new_item');
      expect(['merge', 'skip_exact_duplicate']).toContain(item.suggestion.action);
      expect(item.match).not.toBeNull();
    }
    const matchedIds = items.map((i) => i.match!.existingId).sort();
    expect(matchedIds).toEqual([gravity, wearDown].sort());
  });
});
