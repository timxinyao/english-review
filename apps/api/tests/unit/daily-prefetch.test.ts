import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runPrefetch } from '../../src/jobs/daily-prefetch.js';
import { countQuestionStock } from '../../src/modules/questions/service.js';
import { buildMockRuntime, failingForTargetProvider } from '../helpers/ai';
import { seedExample, seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';

let db: AppDatabase;
const NOW = new Date('2026-09-24T08:00:00.000Z');

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

function inHours(hours: number): string {
  return new Date(NOW.getTime() + hours * 3_600_000).toISOString();
}

/** 一个 active+started、含 source 例句、指定维度在给定时间到期的 item */
async function seedDueItem(
  target: string,
  dimension: 'understanding' | 'production',
  nextReviewAt: string | null,
  overrides: Partial<Parameters<typeof seedItem>[1]> = {},
): Promise<string> {
  const id = await seedItem(db, { target, status: 'active', queueState: 'started', ...overrides });
  await seedExample(db, id, 'source', `An example with ${target}.`);
  await seedReviewState(db, id, dimension, { level: 2, nextReviewAt });
  return id;
}

describe('runPrefetch（daily-prefetch job 核心）', () => {
  it('Understanding 维度 48h 内到期且库存不足 → 补足到目标库存', async () => {
    const itemId = await seedDueItem('alpha', 'understanding', inHours(24));
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);

    expect(summary).toMatchObject({ due: 1, processed: 1, failed: 0, generated: 3 });
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(3);
    expect(countQuestionStock(db, itemId, 'cloze')).toBe(0);
  });

  it('Production 维度到期 → 生成 cloze 题', async () => {
    const itemId = await seedDueItem('beta', 'production', inHours(10));
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);

    expect(summary).toMatchObject({ due: 1, processed: 1, failed: 0 });
    expect(countQuestionStock(db, itemId, 'cloze')).toBe(3);
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(0);
  });

  it('已过期（overdue）的维度也在补足范围内', async () => {
    const itemId = await seedDueItem('gamma', 'understanding', inHours(-24));
    await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(3);
  });

  it('超过 48h 的不处理', async () => {
    const itemId = await seedDueItem('delta', 'understanding', inHours(72));
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(summary.due).toBe(0);
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(0);
  });

  it('next_review_at 为 null（未激活/稳定）的不处理', async () => {
    await seedDueItem('epsilon', 'understanding', null);
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(summary.due).toBe(0);
  });

  it('paused 或 queue_state=new 的 item 不处理', async () => {
    await seedDueItem('zeta', 'understanding', inHours(24), { status: 'paused' });
    await seedDueItem('eta', 'understanding', inHours(24), { queueState: 'new' });
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(summary.due).toBe(0);
  });
  it('库存已达标则跳过，不重复生成', async () => {
    const itemId = await seedDueItem('theta', 'understanding', inHours(24));
    for (let i = 0; i < 3; i++) {
      await seedQuestion(db, itemId, { id: `q${i}`, type: 'understanding', status: 'fresh' });
    }
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(summary).toMatchObject({ due: 1, processed: 0, skipped: 1, generated: 0 });
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(3);
  });

  it('单个 item 失败不中断，其余继续；失败计数汇总', async () => {
    await seedDueItem('failing-target', 'understanding', inHours(24));
    const okItem = await seedDueItem('ok-target', 'understanding', inHours(24));
    const summary = await runPrefetch(
      { db, runtime: buildMockRuntime(failingForTargetProvider('failing-target')) },
      NOW,
    );

    expect(summary).toMatchObject({ due: 2, processed: 1, failed: 1, generated: 3 });
    expect(countQuestionStock(db, okItem, 'understanding')).toBe(3);
  });

  it('部分库存只补差额', async () => {
    const itemId = await seedDueItem('iota', 'understanding', inHours(24));
    await seedQuestion(db, itemId, { id: 'existing', type: 'understanding', status: 'fresh' });
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(summary.generated).toBe(2);
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(3);
  });
});
