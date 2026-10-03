import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { DEFAULT_BACKUP_SETTINGS, type BackupExport } from '@el/shared';
import { loadConfig } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  attempts,
  dailyStats,
  learningExamples,
  learningItems,
  questions,
  reviewSessions,
  reviewStates,
  reviewTasks,
  settings,
} from '../../src/db/schema.js';
import { loginCookie } from '../helpers/test-app.js';
import { seedExample, seedItem, seedReviewState } from '../helpers/seed.js';
import {
  commitRestore,
  createRestoreStore,
  previewRestore,
} from '../../src/modules/import-export/service.js';
import { applyV2Cutover } from '../../src/modules/review/v2-cutover.js';

const apps: FastifyInstance[] = [];
afterAll(async () => {
  for (const app of apps) await app.close();
});

/** 文件库 app：DATABASE_PATH 指向临时目录，快照会写到 <data>/snapshots */
async function newFileApp(): Promise<{
  app: FastifyInstance;
  db: AppDatabase;
  cookie: string;
  dbPath: string;
  snapshotsDir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'backup-restore-'));
  const dbPath = join(dir, 'data', 'test.db');
  const db = createDatabase(dbPath);
  runMigrations(db);
  const config = loadConfig({
    ...process.env,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    AUTH_PASSWORD: 'test-password',
    DATABASE_PATH: dbPath,
  } as unknown as Record<string, string | undefined>);
  const app = buildApp({ config, db, logger: false });
  apps.push(app);
  const cookie = await loginCookie(app);
  return { app, db, cookie, dbPath, snapshotsDir: join(dir, 'data', 'snapshots') };
}

const NOW = '2026-09-20T10:00:00.000Z';

/** 造一套有代表性的数据：1 个进行中 word + 1 个 archived chunk + 例句 + 双维进度 + daily_stats + settings */
async function seedRichData(db: AppDatabase): Promise<{ wordId: string; chunkId: string }> {
  const wordId = await seedItem(db, {
    type: 'word',
    target: 'gravity',
    meaning: '重力',
    ipa: '/ˈɡrævəti/',
    tagsJson: '["science","basic"]',
    status: 'active',
    queueState: 'started',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  });
  await seedExample(db, wordId, 'source', 'Gravity pulls things down.', {
    sortOrder: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  await seedExample(db, wordId, 'extra', 'The law of gravity.', {
    sortOrder: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  await seedExample(db, wordId, 'personal', 'Gravity keeps us on the ground.', {
    originalText: 'gravity keep us on ground',
    betterText: 'Gravity keeps us on the ground.',
    pinned: 1,
    qualityScore: 0.9,
    sortOrder: 1,
    createdAt: '2026-09-05T00:00:00.000Z',
  });
  await seedReviewState(db, wordId, 'understanding', {
    difficulty: 5,
    stability: 15,
    reps: 3,
    nextReviewAt: '2026-09-21T00:00:00.000Z',
    lastReviewAt: '2026-09-14T00:00:00.000Z',
    correctStreak: 2,
    wrongStreak: 0,
  });
  await seedReviewState(db, wordId, 'production', {
    difficulty: 5,
    stability: 5,
    reps: 2,
    nextReviewAt: '2026-09-25T00:00:00.000Z',
    lastReviewAt: '2026-09-15T00:00:00.000Z',
    correctStreak: 1,
    wrongStreak: 1,
  });

  const chunkId = await seedItem(db, {
    type: 'chunk',
    target: 'wear down',
    meaning: '逐渐使疲惫；消耗',
    status: 'archived',
    queueState: 'started',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    archivedAt: '2026-09-01T00:00:00.000Z',
  });
  await seedExample(db, chunkId, 'source', 'It wears you down.', {
    sortOrder: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
  });
  await seedReviewState(db, chunkId, 'understanding', { difficulty: 5, stability: 45, reps: 5 });
  await seedReviewState(db, chunkId, 'production', { difficulty: null, stability: null, reps: 0 });

  await db.insert(dailyStats).values([
    {
      date: '2026-09-18',
      formalTasksCompleted: 6,
      newItemsStarted: 2,
      productionAttempts: 3,
      productionPass: 2,
      updatedAt: NOW,
    },
    {
      date: '2026-09-19',
      formalTasksCompleted: 4,
      newItemsStarted: 0,
      productionAttempts: 1,
      productionPass: 1,
      updatedAt: NOW,
    },
  ]);

  // settings：显式写入非默认值
  await db
    .insert(settings)
    .values({
      id: 1,
      maxNewItemsPerDay: 15,
      contentLevel: 'B2',
      preferredTtsVoice: 'en-US-voice',
      updatedAt: NOW,
    })
    .onConflictDoUpdate({
      target: settings.id,
      set: { maxNewItemsPerDay: 15, contentLevel: 'B2', preferredTtsVoice: 'en-US-voice' },
    });

  return { wordId, chunkId };
}

/** AI 缓存/过程数据：questions + attempts + session/tasks（备份不含，恢复后应清空） */
async function seedDerivedData(db: AppDatabase, itemId: string): Promise<void> {
  await db.insert(questions).values({
    id: 'q-1',
    learningItemId: itemId,
    type: 'understanding',
    status: 'fresh',
    meaningSnapshot: '重力',
    payloadJson: '{}',
    promptKey: 'generate_understanding',
    promptVersion: 1,
    promptHash: 'hash',
    model: 'mock',
    createdAt: NOW,
  });
  await db.insert(reviewSessions).values({
    id: 'sess-1',
    sessionDate: '2026-09-18',
    startedAt: NOW,
    completedAt: NOW,
    baseTaskCount: 3,
    newItemsStarted: 1,
    createdAt: NOW,
  });
  await db.insert(reviewTasks).values({
    id: 'task-1',
    sessionId: 'sess-1',
    learningItemId: itemId,
    dimension: 'understanding',
    questionId: 'q-1',
    taskType: 'understanding',
    origin: 'base',
    sortKey: 1,
    completedAt: NOW,
    createdAt: NOW,
  });
  await db.insert(attempts).values({
    id: 'att-1',
    reviewTaskId: 'task-1',
    learningItemId: itemId,
    questionId: 'q-1',
    mode: 'today',
    result: 'pass',
    viewedSource: 0,
    createdAt: NOW,
  });
}

async function exportBackupBody(
  app: FastifyInstance,
  cookie: string,
): Promise<{ body: Record<string, unknown>; disposition: string | undefined }> {
  const res = await app.inject({ method: 'GET', url: '/api/export/backup', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return { body: res.json(), disposition: res.headers['content-disposition'] };
}

describe('GET /api/export/backup', () => {
  it('V2 export includes nullable goal and preserves Production state after restore', async () => {
    const { app, db, cookie } = await newFileApp();
    const { wordId } = await seedRichData(db);
    db.update(learningItems)
      .set({ productionEnabledOverride: 1 })
      .where(eq(learningItems.id, wordId))
      .run();
    const { body } = await exportBackupBody(app, cookie);
    expect(body.version).toBe('2.0');
    const word = (body.items as Array<Record<string, unknown>>).find((item) => item.id === wordId)!;
    expect(word.productionEnabledOverride).toBe(true);
    expect(
      (word.reviewStates as Array<Record<string, unknown>>).find(
        (s) => s.dimension === 'production',
      ),
    ).toMatchObject({
      difficulty: 5,
      stability: 5,
      reps: 2,
      nextReviewAt: '2026-09-25T00:00:00.000Z',
    });
    expect(applyV2Cutover(db, new Date(NOW), 'Asia/Shanghai')).toEqual({ applied: true });
    const preview = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: body,
    });
    expect(preview.statusCode).toBe(200);
    const commit = await app.inject({
      method: 'POST',
      url: '/api/restore/commit',
      headers: { cookie },
      payload: { previewToken: preview.json().previewToken },
    });
    expect(commit.statusCode).toBe(200);
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, wordId)).get()!
        .productionEnabledOverride,
    ).toBe(1);
    expect(
      db
        .select()
        .from(reviewStates)
        .where(eq(reviewStates.learningItemId, wordId))
        .all()
        .find((s) => s.dimension === 'production'),
    ).toMatchObject({
      difficulty: 5,
      stability: 5,
      reps: 2,
      nextReviewAt: '2026-09-25T00:00:00.000Z',
    });
  });

  it('V1.2 backup without goal field previews and restores with null override', async () => {
    const { app, db, cookie } = await newFileApp();
    const { wordId, chunkId } = await seedRichData(db);
    const { body } = await exportBackupBody(app, cookie);
    const old = {
      ...body,
      version: '1.2',
      items: (body.items as Array<Record<string, unknown>>).map(
        ({ productionEnabledOverride: _removed, ...item }) =>
          item.id === chunkId
            ? { ...item, status: 'active', archivedAt: null, needsReinforcement: 1 }
            : item,
      ),
    };
    expect(applyV2Cutover(db, new Date(NOW), 'Asia/Shanghai')).toEqual({ applied: true });
    const preview = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: old,
    });
    expect(preview.statusCode).toBe(200);
    const beforeCommit = Date.now();
    const commit = await app.inject({
      method: 'POST',
      url: '/api/restore/commit',
      headers: { cookie },
      payload: { previewToken: preview.json().previewToken },
    });
    const afterCommit = Date.now();
    expect(commit.statusCode).toBe(200);
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, wordId)).get()!
        .productionEnabledOverride,
    ).toBeNull();
    expect(
      db
        .select()
        .from(reviewStates)
        .where(eq(reviewStates.learningItemId, wordId))
        .all()
        .find((state) => state.dimension === 'understanding'),
    ).toMatchObject({ difficulty: 5, stability: 15, reps: 3, correctStreak: 2 });
    expect(
      db
        .select()
        .from(reviewStates)
        .where(eq(reviewStates.learningItemId, wordId))
        .all()
        .find((state) => state.dimension === 'production'),
    ).toMatchObject({
      difficulty: null,
      stability: null,
      reps: 0,
      lapses: 0,
      nextReviewAt: null,
      lastReviewAt: null,
      correctStreak: 0,
      wrongStreak: 0,
    });
    expect(db.select().from(dailyStats).all()).toHaveLength(2);
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, chunkId)).get(),
    ).toMatchObject({
      status: 'active',
      needsReinforcement: 0,
      productionEnabledOverride: null,
    });
    const restoredChunkProduction = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, chunkId))
      .all()
      .find((state) => state.dimension === 'production');
    expect(restoredChunkProduction).toMatchObject({ difficulty: null, stability: null, reps: 0 });
    expect(Date.parse(restoredChunkProduction!.nextReviewAt!)).toBeGreaterThanOrEqual(beforeCommit);
    expect(Date.parse(restoredChunkProduction!.nextReviewAt!)).toBeLessThanOrEqual(afterCommit);
  });

  it('结构完整：settings/examples（含 personal 元数据）/reviewStates/dailyStats，含 archived 项', async () => {
    const { app, db, cookie } = await newFileApp();
    const { wordId, chunkId } = await seedRichData(db);

    const { body, disposition } = await exportBackupBody(app, cookie);

    expect(disposition).toMatch(/^attachment; filename="english-review-backup-\d{8}\.json"$/);
    expect(body.version).toBe('2.0');
    expect(typeof body.exportedAt).toBe('string');
    expect(body.settings).toEqual({
      maxNewItemsPerDay: 15,
      contentLevel: 'B2',
      preferredTtsVoice: 'en-US-voice',
    });
    expect(body.dailyStats).toEqual([
      {
        date: '2026-09-18',
        formalTasksCompleted: 6,
        newItemsStarted: 2,
        productionAttempts: 3,
        productionPass: 2,
      },
      {
        date: '2026-09-19',
        formalTasksCompleted: 4,
        newItemsStarted: 0,
        productionAttempts: 1,
        productionPass: 1,
      },
    ]);

    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    const word = items.find((i) => i.id === wordId)!;
    expect(word).toMatchObject({
      type: 'word',
      target: 'gravity',
      meaning: '重力',
      ipa: '/ˈɡrævəti/',
      status: 'active',
      queueState: 'started',
      tags: ['science', 'basic'],
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    const examples = word.examples as Array<Record<string, unknown>>;
    expect(examples).toHaveLength(3);
    const personal = examples.find((e) => e.kind === 'personal')!;
    expect(personal).toMatchObject({
      text: 'Gravity keeps us on the ground.',
      originalText: 'gravity keep us on ground',
      betterText: 'Gravity keeps us on the ground.',
      pinned: 1,
      qualityScore: 0.9,
      sortOrder: 1,
    });
    const states = word.reviewStates as Array<Record<string, unknown>>;
    expect(states).toHaveLength(2);
    expect(states.find((s) => s.dimension === 'understanding')).toMatchObject({
      difficulty: 5,
      stability: 15,
      reps: 3,
      lapses: 0,
      nextReviewAt: '2026-09-21T00:00:00.000Z',
      correctStreak: 2,
    });

    const chunk = items.find((i) => i.id === chunkId)!;
    expect(chunk.status).toBe('archived');
    expect(chunk.archivedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(chunk.ipa).toBeNull();
  });

  it('settings 行缺失时使用默认值；attachment 文件名 english-review-backup-YYYYMMDD.json', async () => {
    const { app, cookie } = await newFileApp();
    const { body, disposition } = await exportBackupBody(app, cookie);

    expect(body.settings).toEqual(DEFAULT_BACKUP_SETTINGS);
    expect(body.items).toEqual([]);
    expect(body.dailyStats).toEqual([]);
    expect(disposition).toMatch(/^attachment; filename="english-review-backup-\d{8}\.json"$/);
  });
});

describe('POST /api/restore/preview', () => {
  it('合法备份：返回 token/计数/当前数据量（仅含 archived 提示）', async () => {
    const { app, db, cookie } = await newFileApp();
    await seedRichData(db);
    const { body: backup } = await exportBackupBody(app, cookie);

    const res = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: backup,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(typeof data.previewToken).toBe('string');
    expect(data.exportedAt).toBe(backup.exportedAt);
    expect(data.itemCount).toBe(2);
    expect(data.dailyStatsDays).toBe(2);
    expect(data.currentItemTotal).toBe(2);
    // 备份含 1 个 archived 项 → 仅该提示；无额度/空备份警告
    expect(data.warnings).toEqual(['备份中包含 1 个已归档学习项，将按原样恢复。']);
  });

  it('警告：archived 项数、maxNewItemsPerDay=-1、备份 items 为空', async () => {
    const { app, cookie } = await newFileApp();
    const base = {
      version: '1.2',
      exportedAt: NOW,
      settings: { maxNewItemsPerDay: -1, contentLevel: 'B1', preferredTtsVoice: null },
      items: [
        {
          id: 'item-a',
          type: 'chunk',
          target: 'wear down',
          meaning: '消耗',
          ipa: null,
          source: null,
          sourceUrl: null,
          tags: [],
          notes: null,
          status: 'archived',
          queueState: 'started',
          needsReinforcement: 0,
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: NOW,
          examples: [],
          reviewStates: [],
        },
      ],
      dailyStats: [],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: base,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.itemCount).toBe(1);
    expect(data.warnings).toHaveLength(2);
    expect(data.warnings.join('\n')).toContain('1');
    expect(data.warnings.join('\n')).toContain('归档');
    expect(data.warnings.join('\n')).toContain('不限制');

    // 空备份
    const empty = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: { ...base, items: [], settings: { ...base.settings, maxNewItemsPerDay: 10 } },
    });
    expect(empty.statusCode).toBe(200);
    const emptyData = empty.json();
    expect(emptyData.itemCount).toBe(0);
    expect(emptyData.warnings).toHaveLength(1);
    expect(emptyData.warnings[0]).toContain('没有学习项');
  });

  it('非法备份：缺 version / version 错 / 缺 settings → 400 VALIDATION_ERROR', async () => {
    const { app, cookie } = await newFileApp();
    const good = {
      version: '1.2',
      exportedAt: NOW,
      settings: { maxNewItemsPerDay: 10, contentLevel: 'B1', preferredTtsVoice: null },
      items: [],
      dailyStats: [],
    };

    const noVersion = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: { ...good, version: undefined },
    });
    expect(noVersion.statusCode).toBe(400);
    expect(noVersion.json().error.code).toBe('VALIDATION_ERROR');

    const wrongVersion = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: { ...good, version: '1.1' },
    });
    expect(wrongVersion.statusCode).toBe(400);

    const noSettings = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: { ...good, settings: undefined },
    });
    expect(noSettings.statusCode).toBe(400);
    expect(noSettings.json().error.message).toContain('settings');
  });
});

describe('POST /api/restore/commit', () => {
  it('round-trip：export → 破坏库 → commit → 学习项/例句/双维进度/daily_stats/settings 全部还原且保留原 id', async () => {
    const { app, db, cookie, snapshotsDir } = await newFileApp();
    const { wordId } = await seedRichData(db);
    await seedDerivedData(db, wordId);
    const { body: backup } = await exportBackupBody(app, cookie);

    // ---- 破坏库 ----
    await db
      .update(learningItems)
      .set({ meaning: '被改坏的释义', status: 'paused', updatedAt: NOW })
      .where(eq(learningItems.id, wordId));
    await db.delete(reviewStates).where(eq(reviewStates.learningItemId, wordId));
    await db.delete(learningExamples).where(eq(learningExamples.learningItemId, wordId));
    await db.delete(dailyStats).where(eq(dailyStats.date, '2026-09-18'));
    await db
      .update(settings)
      .set({ maxNewItemsPerDay: 5, contentLevel: 'A2', preferredTtsVoice: null, updatedAt: NOW });
    await seedItem(db, { type: 'word', target: 'intruder', meaning: '备份外新增' }); // 恢复后应消失

    // ---- preview + commit ----
    const preview = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: backup,
    });
    expect(preview.statusCode).toBe(200);
    const token = preview.json().previewToken;

    const commit = await app.inject({
      method: 'POST',
      url: '/api/restore/commit',
      headers: { cookie },
      payload: { previewToken: token },
    });
    expect(commit.statusCode).toBe(200);
    const result = commit.json();
    expect(result.ok).toBe(true);
    expect(result.restoredItems).toBe(2);
    expect(result.restoredDailyStats).toBe(2);
    expect(result.snapshotFile).toMatch(/^backup-before-restore-\d{8}-\d{6}(-\d+)?\.db$/);

    // ---- 学习项还原（原 id 保留、字段一致） ----
    const rows = db.select().from(learningItems).all();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.id === wordId)).toBe(true);
    expect(rows.some((r) => r.target === 'intruder')).toBe(false);
    const restored = rows.find((r) => r.id === wordId)!;
    expect(restored.meaning).toBe('重力');
    expect(restored.status).toBe('active');
    expect(restored.queueState).toBe('started');
    expect(restored.ipa).toBe('/ˈɡrævəti/');
    expect(restored.tagsJson).toBe('["science","basic"]');
    expect(restored.createdAt).toBe('2026-08-01T00:00:00.000Z');

    // ---- 例句还原（kind/text/original/better/pinned/qualityScore/sortOrder） ----
    const examples = db
      .select()
      .from(learningExamples)
      .where(eq(learningExamples.learningItemId, wordId))
      .all();
    expect(examples).toHaveLength(3);
    const personal = examples.find((e) => e.kind === 'personal')!;
    expect(personal.text).toBe('Gravity keeps us on the ground.');
    expect(personal.originalText).toBe('gravity keep us on ground');
    expect(personal.betterText).toBe('Gravity keeps us on the ground.');
    expect(personal.pinned).toBe(1);
    expect(personal.qualityScore).toBeCloseTo(0.9, 6);
    expect(personal.sortOrder).toBe(1);

    // ---- 双维进度还原 ----
    const states = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, wordId))
      .all();
    expect(states).toHaveLength(2);
    const understanding = states.find((s) => s.dimension === 'understanding')!;
    expect(understanding.difficulty).toBe(5);
    expect(understanding.stability).toBe(15);
    expect(understanding.reps).toBe(3);
    expect(understanding.nextReviewAt).toBe('2026-09-21T00:00:00.000Z');
    expect(understanding.correctStreak).toBe(2);
    const production = states.find((s) => s.dimension === 'production')!;
    expect(production.stability).toBe(5);
    expect(production.reps).toBe(2);

    // ---- daily_stats / settings 还原 ----
    const statsRows = db.select().from(dailyStats).all();
    expect(statsRows.map((r) => r.date).sort()).toEqual(['2026-09-18', '2026-09-19']);
    const restoredStats = statsRows.find((r) => r.date === '2026-09-18')!;
    expect(restoredStats.formalTasksCompleted).toBe(6);
    expect(restoredStats.newItemsStarted).toBe(2);
    const settingsRow = db.select().from(settings).all();
    expect(settingsRow).toHaveLength(1);
    expect(settingsRow[0]!.maxNewItemsPerDay).toBe(15);
    expect(settingsRow[0]!.contentLevel).toBe('B2');
    expect(settingsRow[0]!.preferredTtsVoice).toBe('en-US-voice');

    // ---- 派生数据清空（AI 缓存不还原） ----
    expect(db.select().from(questions).all()).toHaveLength(0);
    expect(db.select().from(attempts).all()).toHaveLength(0);
    expect(db.select().from(reviewTasks).all()).toHaveLength(0);
    expect(db.select().from(reviewSessions).all()).toHaveLength(0);

    // ---- 恢复后 settings API 读取正常 ----
    const settingsRes = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie },
    });
    expect(settingsRes.statusCode).toBe(200);
    expect(settingsRes.json().maxNewItemsPerDay).toBe(15);
    expect(settingsRes.json().contentLevel).toBe('B2');

    // ---- 快照文件存在且可打开（内容为恢复前被破坏的库） ----
    const snapshotPath = join(snapshotsDir, result.snapshotFile);
    expect(existsSync(snapshotPath)).toBe(true);
    const snapshot = new Database(snapshotPath, { readonly: true });
    try {
      const snapItems = snapshot
        .prepare('SELECT target FROM learning_items ORDER BY target')
        .all() as Array<{ target: string }>;
      expect(snapItems.map((r) => r.target)).toEqual(['gravity', 'intruder', 'wear down']);
      const snapMeaning = snapshot
        .prepare('SELECT meaning FROM learning_items WHERE id = ?')
        .get(wordId) as { meaning: string };
      expect(snapMeaning.meaning).toBe('被改坏的释义');
    } finally {
      snapshot.close();
    }
  });

  it('token 一次性：commit 成功后再次使用同 token → 404', async () => {
    const { app, db, cookie } = await newFileApp();
    await seedRichData(db);
    const { body: backup } = await exportBackupBody(app, cookie);

    const preview = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: backup,
    });
    const token = preview.json().previewToken;

    const first = await app.inject({
      method: 'POST',
      url: '/api/restore/commit',
      headers: { cookie },
      payload: { previewToken: token },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/restore/commit',
      headers: { cookie },
      payload: { previewToken: token },
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.message).toBe('预览已过期，请重新上传');
  });

  it('未知 token → 404 预览已过期', async () => {
    const { app, cookie } = await newFileApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/restore/commit',
      headers: { cookie },
      payload: { previewToken: 'no-such-token' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('预览已过期，请重新上传');
  });

  it('过期 token（service 层注入时钟）→ NOT_FOUND', async () => {
    const { db, dbPath } = await newFileApp();
    const config = loadConfig({
      ...process.env,
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      AUTH_PASSWORD: 'test-password',
      DATABASE_PATH: dbPath,
    } as unknown as Record<string, string | undefined>);

    let clock = 1_000;
    const store = createRestoreStore({ now: () => clock, ttlMs: 5_000 });
    const payload: BackupExport = {
      version: '1.2',
      exportedAt: NOW,
      settings: { maxNewItemsPerDay: 10, contentLevel: 'B1', preferredTtsVoice: null },
      items: [],
      dailyStats: [],
    };

    const token = store.put(payload);
    clock = 6_001; // TTL 已过
    await expect(
      commitRestore(db, config, { previewToken: token }, new Date(), store),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('preview/commit 支持 service 层注入 store（previewRestore 签名）', async () => {
    const { db } = await newFileApp();
    const store = createRestoreStore();
    const payload: BackupExport = {
      version: '1.2',
      exportedAt: NOW,
      settings: { maxNewItemsPerDay: 10, contentLevel: 'B1', preferredTtsVoice: null },
      items: [],
      dailyStats: [],
    };

    const preview = await previewRestore(db, payload, store);
    expect(preview.itemCount).toBe(0);
    expect(preview.currentItemTotal).toBe(0);
    expect(preview.warnings).toHaveLength(1);
  });
});

describe('备份文件可直接作为恢复输入（JSON 往返）', () => {
  it('导出的 JSON 文本重新作为 preview payload 校验通过', async () => {
    const { app, db, cookie } = await newFileApp();
    await seedRichData(db);
    const res = await app.inject({ method: 'GET', url: '/api/export/backup', headers: { cookie } });

    const parsed = JSON.parse(res.body) as object;
    const preview = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: parsed,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().itemCount).toBe(2);
  });
});

describe('FSRS 换轨恢复（Task 3：旧格式折算 / 新格式 round-trip）', () => {
  /** 旧 2.0 备份（FSRS 前）：reviewStates 只有 level/stable，无 difficulty/stability 键 */
  function legacyState(
    dimension: 'understanding' | 'production',
    level: number,
    stable: 0 | 1,
    nextReviewAt: string | null,
    lastReviewAt: string | null,
    correctStreak: number,
  ) {
    return {
      dimension,
      level,
      stable,
      nextReviewAt,
      lastReviewAt,
      correctStreak,
      wrongStreak: 0,
    };
  }

  it('旧格式备份（level/stable-only）恢复后行被等级折算重建：stable→S=120、level 阶梯、next/last/streaks 原值', async () => {
    const { app, db, cookie } = await newFileApp();
    const backup = {
      version: '2.0',
      exportedAt: NOW,
      settings: { maxNewItemsPerDay: 10, contentLevel: 'B1', preferredTtsVoice: null },
      items: [
        {
          id: 'legacy-word',
          type: 'word',
          productionEnabledOverride: null,
          target: 'legacy word',
          meaning: '旧词',
          ipa: null,
          source: null,
          sourceUrl: null,
          tags: [],
          notes: null,
          status: 'active',
          queueState: 'started',
          needsReinforcement: 0,
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
          examples: [{ kind: 'source', text: 'A legacy sentence.' }],
          reviewStates: [
            // U：stable=1 → S=120（掌握线）；level=5 → reps=5
            legacyState(
              'understanding',
              5,
              1,
              '2026-10-01T00:00:00.000Z',
              '2026-09-01T00:00:00.000Z',
              5,
            ),
            // P：stable=0、level=2 → S=3（阶梯 [null,1,3,7,14,30,60,120][2]）
            legacyState(
              'production',
              2,
              0,
              '2026-10-02T00:00:00.000Z',
              '2026-09-02T00:00:00.000Z',
              2,
            ),
          ],
        },
        {
          id: 'legacy-inactive',
          type: 'word',
          productionEnabledOverride: null,
          target: 'legacy fresh',
          meaning: '旧未激活词',
          ipa: null,
          source: null,
          sourceUrl: null,
          tags: [],
          notes: null,
          status: 'active',
          queueState: 'new',
          needsReinforcement: 0,
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
          examples: [{ kind: 'source', text: 'Another legacy sentence.' }],
          reviewStates: [
            // level=0 且 stable=0 → 未激活（D/S NULL）
            legacyState('understanding', 0, 0, '2026-10-01T00:00:00.000Z', null, 0),
          ],
        },
      ],
      dailyStats: [],
    };

    const preview = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: backup,
    });
    expect(preview.statusCode).toBe(200);
    const commit = await app.inject({
      method: 'POST',
      url: '/api/restore/commit',
      headers: { cookie },
      payload: { previewToken: preview.json().previewToken },
    });
    expect(commit.statusCode).toBe(200);

    const legacyU = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'legacy-word'))
      .all()
      .find((s) => s.dimension === 'understanding')!;
    expect(legacyU).toMatchObject({
      difficulty: 5,
      stability: 120,
      reps: 5,
      lapses: 0,
      nextReviewAt: '2026-10-01T00:00:00.000Z',
      lastReviewAt: '2026-09-01T00:00:00.000Z',
      correctStreak: 5,
      wrongStreak: 0,
    });
    const legacyP = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'legacy-word'))
      .all()
      .find((s) => s.dimension === 'production')!;
    expect(legacyP).toMatchObject({
      difficulty: 5,
      stability: 3,
      reps: 2,
      lapses: 0,
      nextReviewAt: '2026-10-02T00:00:00.000Z',
      lastReviewAt: '2026-09-02T00:00:00.000Z',
    });
    // level=0 → 未激活（D/S NULL），reps=0
    const inactiveU = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'legacy-inactive'))
      .all()
      .find((s) => s.dimension === 'understanding')!;
    expect(inactiveU).toMatchObject({
      difficulty: null,
      stability: null,
      reps: 0,
      lapses: 0,
    });
  });

  it('V1.2 stable word 项恢复后翻回 mastered（折算 S=120 + commit 末尾 reconcile）；chunk 因 P 未激活保持 active', async () => {
    const { app, db, cookie } = await newFileApp();
    const backup = {
      version: '1.2',
      exportedAt: NOW,
      settings: { maxNewItemsPerDay: 10, contentLevel: 'B1', preferredTtsVoice: null },
      items: [
        {
          // 旧版 U stable=1 的 word（production 默认关闭）在导出时就是 mastered
          id: 'v12-stable-word',
          type: 'word',
          target: 'stable word',
          meaning: '已稳定旧词',
          ipa: null,
          source: null,
          sourceUrl: null,
          tags: [],
          notes: null,
          status: 'mastered',
          queueState: 'started',
          needsReinforcement: 0,
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
          examples: [{ kind: 'source', text: 'A stable sentence.' }],
          reviewStates: [
            legacyState(
              'understanding',
              5,
              1,
              '2026-10-01T00:00:00.000Z',
              '2026-09-01T00:00:00.000Z',
              5,
            ),
          ],
        },
        {
          // 同样 U stable=1 的 chunk：production 默认开启，V1.2 normalize 后 P 恒未激活 → 不翻 mastered
          id: 'v12-stable-chunk',
          type: 'chunk',
          target: 'stable chunk',
          meaning: '已稳定旧块',
          ipa: null,
          source: null,
          sourceUrl: null,
          tags: [],
          notes: null,
          status: 'mastered',
          queueState: 'started',
          needsReinforcement: 0,
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
          examples: [{ kind: 'source', text: 'A stable chunk sentence.' }],
          reviewStates: [
            legacyState(
              'understanding',
              5,
              1,
              '2026-10-01T00:00:00.000Z',
              '2026-09-01T00:00:00.000Z',
              5,
            ),
          ],
        },
      ],
      dailyStats: [],
    };

    const preview = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: backup,
    });
    expect(preview.statusCode).toBe(200);
    const commit = await app.inject({
      method: 'POST',
      url: '/api/restore/commit',
      headers: { cookie },
      payload: { previewToken: preview.json().previewToken },
    });
    expect(commit.statusCode).toBe(200);

    // U 折算 stable→S=120，且 word（production 关闭）当场翻回 mastered，不等下次作答
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'v12-stable-word')).get()!.status,
    ).toBe('mastered');
    expect(
      db
        .select()
        .from(reviewStates)
        .where(eq(reviewStates.learningItemId, 'v12-stable-word'))
        .all()
        .find((s) => s.dimension === 'understanding'),
    ).toMatchObject({ stability: 120 });
    // chunk：P 重置未激活 → 掌握线要求 P，保持 active
    expect(
      db.select().from(learningItems).where(eq(learningItems.id, 'v12-stable-chunk')).get()!.status,
    ).toBe('active');
  });

  it('2.0 含 FSRS 字段 round-trip：D/S/reps/lapses 精确保留，不走折算', async () => {
    const { app, db, cookie } = await newFileApp();
    const backup = {
      version: '2.0',
      exportedAt: NOW,
      settings: { maxNewItemsPerDay: 10, contentLevel: 'B1', preferredTtsVoice: null },
      items: [
        {
          id: 'fsrs-word',
          type: 'word',
          productionEnabledOverride: null,
          target: 'fsrs word',
          meaning: '新格式词',
          ipa: null,
          source: null,
          sourceUrl: null,
          tags: [],
          notes: null,
          status: 'active',
          queueState: 'started',
          needsReinforcement: 0,
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
          examples: [{ kind: 'source', text: 'An FSRS sentence.' }],
          reviewStates: [
            {
              dimension: 'understanding',
              difficulty: 4.2,
              stability: 33.5,
              reps: 7,
              lapses: 2,
              nextReviewAt: '2026-10-05T00:00:00.000Z',
              lastReviewAt: '2026-09-05T00:00:00.000Z',
              correctStreak: 3,
              wrongStreak: 0,
            },
          ],
        },
      ],
      dailyStats: [],
    };

    const preview = await app.inject({
      method: 'POST',
      url: '/api/restore/preview',
      headers: { cookie },
      payload: backup,
    });
    expect(preview.statusCode).toBe(200);
    const commit = await app.inject({
      method: 'POST',
      url: '/api/restore/commit',
      headers: { cookie },
      payload: { previewToken: preview.json().previewToken },
    });
    expect(commit.statusCode).toBe(200);

    const restored = db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.learningItemId, 'fsrs-word'))
      .all()
      .find((s) => s.dimension === 'understanding')!;
    expect(restored.difficulty).toBeCloseTo(4.2, 6);
    expect(restored.stability).toBeCloseTo(33.5, 6);
    expect(restored.reps).toBe(7);
    expect(restored.lapses).toBe(2);
    expect(restored.nextReviewAt).toBe('2026-10-05T00:00:00.000Z');
    expect(restored.lastReviewAt).toBe('2026-09-05T00:00:00.000Z');
    expect(restored.correctStreak).toBe(3);
  });
});
