import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { ReadArticleView } from '@el/shared';
import { loadConfig } from '../../src/config.js';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { readArticleItems, readArticles, learningItems } from '../../src/db/schema.js';

const DAY_MS = 24 * 3600 * 1000;
const NOW = new Date('2026-09-25T12:00:00.000Z');

let app: FastifyInstance;
let db: AppDatabase;

beforeAll(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
  const config = loadConfig({
    ...(process.env as Record<string, string | undefined>),
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    AUTH_PASSWORD: 'test-password',
    DATABASE_PATH: ':memory:',
  } as Record<string, string>);
  app = buildApp({ config, db, logger: false });

  // 详情视图需要 learning_items 的 target（外键 + 展示）
  const now = NOW.toISOString();
  for (const [id, target] of [
    ['it-stable', 'stable'],
    ['it-old', 'gravity'],
  ] as const) {
    db.insert(learningItems)
      .values({
        id,
        type: 'word',
        target,
        meaning: '测试释义',
        ipa: null,
        source: null,
        sourceUrl: null,
        tagsJson: '[]',
        notes: null,
        status: 'active',
        queueState: 'started',
        needsReinforcement: 0,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      })
      .run();
  }
});

afterAll(async () => {
  await app.close();
});

async function loginCookie(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'test-password' },
  });
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc[0]! : sc!).split(';')[0]!;
}

function seedArticle(overrides: Partial<typeof readArticles.$inferInsert> = {}): string {
  const id = `art-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insert(readArticles)
    .values({
      title: 'A Test Article',
      body: 'Paragraph one is stable.\n\nParagraph two wears me down.',
      contentLevel: 'B1',
      favorite: 0,
      promptKey: 'generate_read',
      promptVersion: 1,
      promptHash: 'seed',
      model: 'seed',
      createdAt: now,
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
      type: 'story',
      checksJson: JSON.stringify([
        {
          id: 'chk-1',
          learningItemId: 'it-stable',
          question: '文中 stable 的意思是什么？',
          options: [
            { id: 'o1', text: '稳定的' },
            { id: 'o2', text: '干扰' },
          ],
          correctOptionId: 'o1',
        },
      ]),
      ...{ ...overrides, id },
    })
    .run();
  db.insert(readArticleItems)
    .values([
      {
        readArticleId: id,
        learningItemId: 'it-stable',
        role: 'focus',
        highlighted: 1,
        surfaceForm: 'stable',
      },
      {
        readArticleId: id,
        learningItemId: 'it-old',
        role: 'old',
        highlighted: 0,
        surfaceForm: null,
      },
    ])
    .run();
  return id;
}

describe('GET /api/read/:id（文章详情）', () => {
  it('需登录', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/read/art-x' });
    expect(res.statusCode).toBe(401);
  });

  it('返回完整视图：focus 含持久化 surfaceForm，checks 不含 correctOptionId', async () => {
    const cookie = await loginCookie();
    const id = seedArticle();
    const res = await app.inject({ method: 'GET', url: `/api/read/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(ReadArticleView.safeParse(body).success).toBe(true);
    expect(body.focusItems).toEqual([
      { learningItemId: 'it-stable', target: 'stable', surfaceForm: 'stable' },
    ]);
    expect(body.oldItems).toEqual([{ learningItemId: 'it-old', target: 'gravity' }]);
    expect(body.checks[0].options).toHaveLength(2);
    expect(JSON.stringify(body.checks)).not.toContain('correctOptionId');
  });

  it('不存在 → 404', async () => {
    const cookie = await loginCookie();
    const res = await app.inject({
      method: 'GET',
      url: '/api/read/no-such-id',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('已过期 → 404；收藏（expires_at=null）不过期', async () => {
    const cookie = await loginCookie();
    const expired = seedArticle({
      expiresAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
    });
    const res1 = await app.inject({
      method: 'GET',
      url: `/api/read/${expired}`,
      headers: { cookie },
    });
    expect(res1.statusCode).toBe(404);

    const fav = seedArticle({ favorite: 1, expiresAt: null });
    const res2 = await app.inject({ method: 'GET', url: `/api/read/${fav}`, headers: { cookie } });
    expect(res2.statusCode).toBe(200);
  });
});
