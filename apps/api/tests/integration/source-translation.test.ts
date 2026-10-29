import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDatabase, rawSqlite, type AppDatabase } from '../../src/db/client.js';
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
} from '../../src/db/schema.js';
import { loginCookie } from '../helpers/test-app.js';
import { seedExample, seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';

const SOURCE = 'Gravity pulls things down.';
const TRANSLATION = '重力把物体向下拉。';
const apps: FastifyInstance[] = [];
const databases: AppDatabase[] = [];
afterAll(async () => {
  for (const app of apps) await app.close();
  for (const db of databases) rawSqlite(db).close();
});

async function newApp() {
  const dir = mkdtempSync(join(tmpdir(), 'source-translation-'));
  const db = createDatabase(join(dir, 'test.db'));
  databases.push(db);
  runMigrations(db);
  const config = loadConfig({
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    AUTH_PASSWORD: 'test-password',
    DATABASE_PATH: join(dir, 'test.db'),
  });
  const app = buildApp({ config, db, logger: false });
  apps.push(app);
  const cookie = await loginCookie(app);
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/library/${id}`, headers: { cookie }, payload });
  const preview = (fields: Record<string, unknown> = {}) =>
    post('/api/import/preview', {
      version: '2.0',
      items: [
        { type: 'word', target: 'gravity', meaning: '重力', source_example: SOURCE, ...fields },
      ],
    });
  const commit = (previewToken: string, merge = false) =>
    post('/api/import/commit', {
      previewToken,
      decisions: merge ? [{ index: 0, action: 'merge' }] : [],
    });
  return { app, db, get, post, patch, preview, commit };
}

async function seedExisting(db: AppDatabase) {
  const id = await seedItem(db, { target: 'gravity', meaning: '重力', queueState: 'started' });
  await seedExample(db, id, 'source', SOURCE);
  await seedExample(db, id, 'personal', 'Gravity keeps me on the ground.', { pinned: 1 });
  await seedReviewState(db, id, 'understanding', {
    difficulty: 4,
    stability: 30,
    reps: 7,
    lapses: 2,
    nextReviewAt: '2026-12-01T00:00:00.000Z',
  });
  await seedReviewState(db, id, 'production', {
    difficulty: 5,
    stability: 10,
    reps: 3,
    nextReviewAt: '2026-12-03T00:00:00.000Z',
  });
  const questionId = await seedQuestion(db, id);
  await db.insert(attempts).values({
    id: 'old-attempt',
    learningItemId: id,
    questionId,
    mode: 'library_practice',
    result: 'pass',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  return id;
}

describe('source sentence translation persistence', () => {
  it('stores imported translation and exposes the same value through Library, Today, and library export', async () => {
    const ctx = await newApp();
    const preview = await ctx.preview({ source_example_translation: `  ${TRANSLATION}  ` });
    expect(preview.statusCode).toBe(200);
    expect((await ctx.commit(preview.json().previewToken)).json()).toMatchObject({ created: 1 });
    const id = ctx.db.select().from(learningItems).get()!.id;
    const detail = (await ctx.get(`/api/library/${id}`)).json();
    expect(detail.sourceExampleTranslation).toBe(TRANSLATION);
    const start = await ctx.post('/api/today/start', {});
    expect(start.statusCode).toBe(200);
    expect(start.json().currentTask).toMatchObject({
      sourceExample: SOURCE,
      sourceExampleTranslation: TRANSLATION,
    });
    expect((await ctx.get('/api/today/tasks')).json().tasks[0].task.sourceExampleTranslation).toBe(
      TRANSLATION,
    );
    const exported = (await ctx.get('/api/export/library')).json();
    expect(exported.items[0].source_example_translation).toBe(TRANSLATION);
    const target = await newApp();
    const targetPreview = await target.post('/api/import/preview', exported);
    expect((await target.commit(targetPreview.json().previewToken)).statusCode).toBe(200);
    expect((await target.get('/api/export/library')).json()).toEqual(exported);
  });

  it('suggests merge for exact duplicate enrichment and preserves all learning state/history', async () => {
    const ctx = await newApp();
    const id = await seedExisting(ctx.db);
    const before = {
      states: ctx.db.select().from(reviewStates).all(),
      attempts: ctx.db.select().from(attempts).all(),
      questions: ctx.db.select().from(questions).all(),
      tasks: ctx.db.select().from(reviewTasks).all(),
      sessions: ctx.db.select().from(reviewSessions).all(),
      stats: ctx.db.select().from(dailyStats).all(),
      personal: ctx.db
        .select()
        .from(learningExamples)
        .where(eq(learningExamples.kind, 'personal'))
        .all(),
    };
    const preview = await ctx.preview({ source_example_translation: TRANSLATION });
    expect(preview.json().items[0].suggestion.action).toBe('merge');
    expect((await ctx.commit(preview.json().previewToken)).json()).toMatchObject({
      merged: 1,
      created: 0,
      skipped: 0,
    });
    expect((await ctx.get(`/api/library/${id}`)).json().sourceExampleTranslation).toBe(TRANSLATION);
    expect(ctx.db.select().from(reviewStates).all()).toEqual(before.states);
    expect(ctx.db.select().from(attempts).all()).toEqual(before.attempts);
    expect(ctx.db.select().from(questions).all()).toEqual(before.questions);
    expect(ctx.db.select().from(reviewTasks).all()).toEqual(before.tasks);
    expect(ctx.db.select().from(reviewSessions).all()).toEqual(before.sessions);
    expect(ctx.db.select().from(dailyStats).all()).toEqual(before.stats);
    expect(
      ctx.db.select().from(learningExamples).where(eq(learningExamples.kind, 'personal')).all(),
    ).toEqual(before.personal);
    expect(ctx.db.select().from(learningItems).get()).toMatchObject({
      queueState: 'started',
      status: 'active',
    });
  });

  it.each(['import', 'library'] as const)(
    'preserves explicitly resumed active status during translation-only %s enrichment',
    async (mode) => {
      const ctx = await newApp();
      const id = await seedExisting(ctx.db);
      for (const action of ['master', 'pause', 'resume']) {
        expect((await ctx.post(`/api/library/${id}/${action}`, {})).statusCode).toBe(200);
      }
      const states = ctx.db.select().from(reviewStates).all();
      const before = ctx.db.select().from(learningItems).get()!;
      expect(before.status).toBe('active');
      if (mode === 'import') {
        const exported = (await ctx.get('/api/export/library')).json();
        expect(exported.items[0].production_enabled_override).toBeNull();
        exported.items[0].source_example_translation = TRANSLATION;
        const preview = await ctx.post('/api/import/preview', exported);
        expect(preview.json().items[0].suggestion.action).toBe('merge');
        expect((await ctx.commit(preview.json().previewToken)).statusCode).toBe(200);
      } else {
        expect((await ctx.patch(id, { sourceExampleTranslation: TRANSLATION })).statusCode).toBe(
          200,
        );
      }
      expect(ctx.db.select().from(reviewStates).all()).toEqual(states);
      expect(ctx.db.select().from(learningItems).get()).toMatchObject({
        status: 'active',
        queueState: before.queueState,
      });
      expect((await ctx.get(`/api/library/${id}`)).json().sourceExampleTranslation).toBe(
        TRANSLATION,
      );
    },
  );

  it('warns on conflicting translation and preserves the existing text even when merge is selected', async () => {
    const ctx = await newApp();
    const id = await seedExisting(ctx.db);
    await ctx.patch(id, { sourceExampleTranslation: TRANSLATION });
    const preview = await ctx.preview({ source_example_translation: '另一版译文。' });
    expect(preview.json().items[0].warnings.join(' ')).toMatch(/译文.*(冲突|不同)/);
    expect((await ctx.commit(preview.json().previewToken, true)).statusCode).toBe(200);
    expect((await ctx.get(`/api/library/${id}`)).json().sourceExampleTranslation).toBe(TRANSLATION);
  });

  it.each([undefined, null, '', '   '])(
    'does not clear existing translation for imported %s',
    async (value) => {
      const ctx = await newApp();
      const id = await seedExisting(ctx.db);
      await ctx.patch(id, { sourceExampleTranslation: TRANSLATION });
      const preview = await ctx.preview(
        value === undefined ? {} : { source_example_translation: value },
      );
      expect((await ctx.commit(preview.json().previewToken, true)).statusCode).toBe(200);
      expect((await ctx.get(`/api/library/${id}`)).json().sourceExampleTranslation).toBe(
        TRANSLATION,
      );
    },
  );

  it('attaches a different source translation only to its appended example, never the retained source', async () => {
    const ctx = await newApp();
    const id = await seedExisting(ctx.db);
    const otherSource = 'There is less gravity on the Moon.';
    const preview = await ctx.preview({
      source_example: otherSource,
      source_example_translation: '月球上的重力更小。',
    });
    expect((await ctx.commit(preview.json().previewToken, true)).statusCode).toBe(200);
    expect((await ctx.get(`/api/library/${id}`)).json()).toMatchObject({
      sourceExample: SOURCE,
      sourceExampleTranslation: null,
    });
    const examples = ctx.db.select().from(learningExamples).all();
    expect(examples.find((row) => row.text === otherSource)).toMatchObject({
      kind: 'extra',
      translation: '月球上的重力更小。',
    });
  });

  it('does not attach translations across sentence capitalization changes with different meanings', async () => {
    const ctx = await newApp();
    const id = await seedExisting(ctx.db);
    await ctx.patch(id, { sourceExample: 'Polish is difficult.' });
    const preview = await ctx.preview({
      source_example: 'polish is difficult.',
      source_example_translation: '抛光很难。',
    });
    expect(preview.json().items[0].suggestion.action).toBe('merge');
    expect((await ctx.commit(preview.json().previewToken)).statusCode).toBe(200);
    expect((await ctx.get(`/api/library/${id}`)).json()).toMatchObject({
      sourceExample: 'Polish is difficult.',
      sourceExampleTranslation: null,
    });
    expect(
      ctx.db.select().from(learningExamples).where(eq(learningExamples.kind, 'extra')).get(),
    ).toMatchObject({ text: 'polish is difficult.', translation: '抛光很难。' });
  });

  it('retains omitted translation for unchanged source; changed source clears it unless explicitly replaced', async () => {
    const ctx = await newApp();
    const id = await seedExisting(ctx.db);
    const set = await ctx.patch(id, { sourceExampleTranslation: TRANSLATION });
    expect(set.json().sourceExampleTranslation).toBe(TRANSLATION);
    expect(
      (await ctx.patch(id, { sourceExample: SOURCE, notes: 'still current' })).json()
        .sourceExampleTranslation,
    ).toBe(TRANSLATION);
    expect(
      (await ctx.patch(id, { sourceExample: 'Gravity keeps us on Earth.' })).json()
        .sourceExampleTranslation,
    ).toBeNull();
    expect(
      (await ctx.patch(id, { sourceExample: SOURCE, sourceExampleTranslation: TRANSLATION })).json()
        .sourceExampleTranslation,
    ).toBe(TRANSLATION);
    expect(
      (await ctx.patch(id, { sourceExampleTranslation: '修订后的译文。' })).json()
        .sourceExampleTranslation,
    ).toBe('修订后的译文。');
    expect(
      (await ctx.patch(id, { sourceExampleTranslation: null })).json().sourceExampleTranslation,
    ).toBeNull();
    await ctx.patch(id, { sourceExampleTranslation: TRANSLATION });
    expect(
      (await ctx.patch(id, { sourceExampleTranslation: '   ' })).json().sourceExampleTranslation,
    ).toBeNull();
  });

  it('preserves a translated extra sentence through unchanged Library extra edits', async () => {
    const ctx = await newApp();
    const id = await seedExisting(ctx.db);
    const text = 'There is less gravity on the Moon.';
    await seedExample(ctx.db, id, 'extra', text, { translation: '月球上的重力更小。' });
    expect((await ctx.patch(id, { notes: 'updated', extraExamples: [text] })).statusCode).toBe(200);
    expect(
      ctx.db.select().from(learningExamples).where(eq(learningExamples.kind, 'extra')).get(),
    ).toMatchObject({ text, translation: '月球上的重力更小。' });
    await ctx.patch(id, { extraExamples: ['There is no gravity here.'] });
    expect(
      ctx.db.select().from(learningExamples).where(eq(learningExamples.kind, 'extra')).get(),
    ).toMatchObject({ text: 'There is no gravity here.', translation: null });
  });

  it('clears stale personal translation only when that sentence changes, not for pin or unchanged text', async () => {
    const ctx = await newApp();
    const id = await seedExisting(ctx.db);
    const personal = ctx.db
      .select()
      .from(learningExamples)
      .where(eq(learningExamples.kind, 'personal'))
      .get()!;
    const preview = await ctx.preview({
      source_example: personal.text,
      source_example_translation: '重力让我留在地面上。',
    });
    await ctx.commit(preview.json().previewToken, true);
    await ctx.patch(id, {
      personalExamples: [{ id: personal.id, pinned: false, text: personal.text }],
    });
    expect(
      ctx.db.select().from(learningExamples).where(eq(learningExamples.id, personal.id)).get(),
    ).toHaveProperty('translation', '重力让我留在地面上。');
    await ctx.patch(id, {
      personalExamples: [{ id: personal.id, text: 'Gravity keeps me on Earth.' }],
    });
    expect(
      ctx.db.select().from(learningExamples).where(eq(learningExamples.id, personal.id)).get(),
    ).toHaveProperty('translation', null);
  });

  it('warns on translation conflicts for a matching sentence even when meaning differs', async () => {
    const ctx = await newApp();
    const id = await seedExisting(ctx.db);
    await ctx.patch(id, { sourceExampleTranslation: TRANSLATION });
    const preview = await ctx.preview({
      meaning: '引力',
      source_example_translation: '另一版译文。',
    });
    expect(preview.json().items[0].warnings.join(' ')).toMatch(/译文.*(冲突|不同)/);
    expect((await ctx.commit(preview.json().previewToken, true)).statusCode).toBe(200);
    expect((await ctx.get(`/api/library/${id}`)).json().sourceExampleTranslation).toBe(TRANSLATION);
  });

  it('backfills only the matching extra sentence and warns instead of replacing its translation', async () => {
    const ctx = await newApp();
    const id = await seedExisting(ctx.db);
    const text = 'There is less gravity on the Moon.';
    await seedExample(ctx.db, id, 'extra', text);
    const preview = await ctx.preview({
      source_example: text,
      source_example_translation: '月球上的重力更小。',
    });
    expect((await ctx.commit(preview.json().previewToken, true)).statusCode).toBe(200);
    expect((await ctx.get(`/api/library/${id}`)).json().sourceExampleTranslation).toBeNull();
    expect(
      ctx.db.select().from(learningExamples).where(eq(learningExamples.kind, 'extra')).get(),
    ).toMatchObject({ text, translation: '月球上的重力更小。' });
    const conflict = await ctx.preview({
      source_example: text,
      source_example_translation: '另一版译文。',
    });
    expect(conflict.json().items[0].warnings.join(' ')).toMatch(/译文.*(冲突|不同)/);
    expect((await ctx.commit(conflict.json().previewToken, true)).statusCode).toBe(200);
    expect(
      ctx.db.select().from(learningExamples).where(eq(learningExamples.kind, 'extra')).get(),
    ).toHaveProperty('translation', '月球上的重力更小。');
  });

  it('round-trips translations in backup/restore and restores old backups without them', async () => {
    const ctx = await newApp();
    const id = await seedExisting(ctx.db);
    await ctx.patch(id, { sourceExampleTranslation: TRANSLATION });
    await seedExample(ctx.db, id, 'extra', 'There is less gravity on the Moon.', {
      translation: '月球上的重力更小。',
    });
    const personal = ctx.db
      .select()
      .from(learningExamples)
      .where(eq(learningExamples.kind, 'personal'))
      .get()!;
    const enrichment = await ctx.preview({
      source_example: personal.text,
      source_example_translation: '重力让我留在地面上。',
    });
    await ctx.commit(enrichment.json().previewToken, true);
    const backup = (await ctx.get('/api/export/backup')).json();
    expect(
      backup.items[0].examples.find((row: { kind: string }) => row.kind === 'source').translation,
    ).toBe(TRANSLATION);
    const target = await newApp();
    const preview = await target.post('/api/restore/preview', backup);
    expect(preview.statusCode).toBe(200);
    const restored = await target.post('/api/restore/commit', {
      previewToken: preview.json().previewToken,
    });
    expect(restored.statusCode).toBe(200);
    expect((await target.get(`/api/library/${id}`)).json().sourceExampleTranslation).toBe(
      TRANSLATION,
    );
    expect((await target.get('/api/export/backup')).json().items[0].examples).toEqual(
      backup.items[0].examples,
    );
    for (const item of backup.items)
      for (const example of item.examples) delete example.translation;
    const legacyPreview = await target.post('/api/restore/preview', backup);
    expect(
      (
        await target.post('/api/restore/commit', {
          previewToken: legacyPreview.json().previewToken,
        })
      ).statusCode,
    ).toBe(200);
    expect((await target.get(`/api/library/${id}`)).json().sourceExampleTranslation).toBeNull();
  });
});
