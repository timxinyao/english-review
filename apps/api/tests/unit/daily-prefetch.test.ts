import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  createMockProvider,
  type AiProvider,
  type ProviderRequest,
} from '../../src/ai/provider/index.js';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { jobLocks } from '../../src/db/schema.js';
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

/** 一个 active+new、含 source 例句的新词 item（understanding 库存 0） */
async function seedNewItem(id: string, createdAt: string): Promise<string> {
  await seedItem(db, { id, target: id, status: 'active', queueState: 'new', createdAt });
  await seedExample(db, id, 'source', `An example with ${id}.`);
  return id;
}

/** 一个 active+started、含 source 例句、指定维度在给定时间到期的 item */
async function seedDueItem(
  target: string,
  dimension: 'understanding' | 'production',
  nextReviewAt: string | null,
  overrides: Partial<Parameters<typeof seedItem>[1]> = {},
  stability = 5,
): Promise<string> {
  const id = await seedItem(db, { target, status: 'active', queueState: 'started', ...overrides });
  await seedExample(db, id, 'source', `An example with ${target}.`);
  await seedReviewState(db, id, dimension, {
    difficulty: 5,
    stability,
    reps: 2,
    nextReviewAt,
  });
  return id;
}

describe('runPrefetch（daily-prefetch job 核心）', () => {
  it('Understanding 维度到期 → 不再备货（RecallCard 三档自评不消费绑定题，2026-10-06 收敛）', async () => {
    const itemId = await seedDueItem('alpha', 'understanding', inHours(24));
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);

    expect(summary).toMatchObject({ due: 1, processed: 0, skipped: 1, failed: 0, generated: 0 });
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(0);
  });

  it('启用的 Production 到期 → 只生成完整造句题', async () => {
    const itemId = await seedDueItem('beta', 'production', inHours(10), { type: 'chunk' });
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);

    expect(summary).toMatchObject({ due: 1, processed: 1, failed: 0, generated: 2 });
    expect(countQuestionStock(db, itemId, 'production')).toBe(2);
    expect(countQuestionStock(db, itemId, 'cloze')).toBe(0);
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(0);
  });

  it('P-L0 与 P-L3 到期只补 production 库存', async () => {
    const first = await seedDueItem('first-0', 'production', inHours(10), { type: 'chunk' }, 0);
    const third = await seedDueItem('mix-3', 'production', inHours(10), { type: 'chunk' }, 3);
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);

    expect(summary).toMatchObject({ due: 2, processed: 2, failed: 0, generated: 4 });
    for (const itemId of [first, third]) {
      expect(countQuestionStock(db, itemId, 'cloze')).toBe(0);
      expect(countQuestionStock(db, itemId, 'production')).toBe(2);
    }
  });

  it('P-L5 到期 → 同样补 production 库存（目标 2）', async () => {
    const itemId = await seedDueItem('late-5', 'production', inHours(20), { type: 'chunk' }, 5);
    await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(countQuestionStock(db, itemId, 'production')).toBe(2);
  });

  it('旧 cloze 库存充足不能抵充 P 库存', async () => {
    const itemId = await seedDueItem(
      'mix-stocked',
      'production',
      inHours(10),
      { type: 'chunk' },
      3,
    );
    for (let i = 0; i < 3; i++) {
      await seedQuestion(db, itemId, { id: `cloze-${i}`, type: 'cloze', status: 'fresh' });
    }
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(summary).toMatchObject({ due: 1, processed: 1, generated: 2 });
    expect(countQuestionStock(db, itemId, 'cloze')).toBe(3);
    expect(countQuestionStock(db, itemId, 'production')).toBe(2);
  });

  it('P-L3 production 库存已达标 → 不补旧 cloze 库存', async () => {
    const itemId = await seedDueItem(
      'mix-stocked',
      'production',
      inHours(10),
      { type: 'chunk' },
      3,
    );
    for (let i = 0; i < 2; i++) {
      await seedQuestion(db, itemId, {
        id: `p${i}`,
        type: 'production',
        status: 'fresh',
        promptText: `题 ${i}`,
        payloadJson: JSON.stringify({
          mustUse: 'mix-stocked',
          referenceAnswer: `Ref ${i}`,
          acceptanceNotes: '允许变化。',
        }),
      });
    }
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(countQuestionStock(db, itemId, 'production')).toBe(2);
    expect(countQuestionStock(db, itemId, 'cloze')).toBe(0);
    expect(summary.processed).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('关闭的 P（默认 word 或显式关闭的 chunk）不会进入到期预取', async () => {
    const word = await seedDueItem('word-off', 'production', inHours(10));
    const chunk = await seedDueItem('chunk-off', 'production', inHours(10), {
      type: 'chunk',
      productionEnabledOverride: 0,
    });
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(summary).toMatchObject({ due: 0, processed: 0, generated: 0 });
    expect(countQuestionStock(db, word, 'production')).toBe(0);
    expect(countQuestionStock(db, chunk, 'production')).toBe(0);
  });

  it('显式开启的 word P 仍进入到期预取', async () => {
    const itemId = await seedDueItem('word-on', 'production', inHours(10), {
      productionEnabledOverride: 1,
    });
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(summary).toMatchObject({ due: 1, generated: 2 });
    expect(countQuestionStock(db, itemId, 'production')).toBe(2);
  });

  it('已过期（overdue）的维度也在补足范围内', async () => {
    const itemId = await seedDueItem('gamma', 'production', inHours(-24), { type: 'chunk' });
    await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(countQuestionStock(db, itemId, 'production')).toBe(2);
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
    await seedDueItem('failing-target', 'production', inHours(24), { type: 'chunk' });
    const okItem = await seedDueItem('ok-target', 'production', inHours(24), { type: 'chunk' });
    const summary = await runPrefetch(
      { db, runtime: buildMockRuntime(failingForTargetProvider('failing-target')) },
      NOW,
    );

    expect(summary).toMatchObject({ due: 2, processed: 1, failed: 1, generated: 2 });
    expect(countQuestionStock(db, okItem, 'production')).toBe(2);
  });

  it('部分库存只补差额', async () => {
    const itemId = await seedDueItem('iota', 'production', inHours(24), { type: 'chunk' });
    await seedQuestion(db, itemId, { id: 'existing', type: 'production', status: 'fresh' });
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(summary.generated).toBe(1);
    expect(countQuestionStock(db, itemId, 'production')).toBe(2);
  });
});

describe('runPrefetch 新词队列（2026-10-06 起不备货）', () => {
  it('新词不生成 understanding 题目（Learn=RecallCard 不消费绑定题；练一下走懒生成）', async () => {
    const itemId = await seedNewItem('new-a', '2026-09-01T00:00:00.000Z');
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);

    expect(summary).toMatchObject({ due: 0, processed: 0, skipped: 0, failed: 0, generated: 0 });
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(0);
  });

  it('runPrefetch 整体持 question-generation 锁：执行期间锁行存在，结束后 job_locks 清空', async () => {
    await seedDueItem('lock-new', 'production', inHours(24), { type: 'chunk' });
    const inner = createMockProvider();
    // 首次 AI 调用时探针：执行期间锁行必须存在且租约未过期
    let during: { holder: string; leaseUntil: string } | undefined;
    const provider: AiProvider = {
      name: inner.name,
      async complete(req: ProviderRequest) {
        if (!during) {
          const row = db
            .select()
            .from(jobLocks)
            .where(eq(jobLocks.name, 'question-generation'))
            .get();
          during = row ? { holder: row.holder, leaseUntil: row.leaseUntil } : undefined;
        }
        return inner.complete(req);
      },
    };
    const summary = await runPrefetch({ db, runtime: buildMockRuntime(provider) }, NOW);

    expect(summary.processed).toBe(1); // 确保探针真的跑过
    expect(during).toBeDefined();
    expect(during?.holder).toContain(String(process.pid));
    expect(during && during.leaseUntil > new Date().toISOString()).toBe(true);
    // 释放无残留
    expect(db.select().from(jobLocks).all()).toHaveLength(0);
  });
});
