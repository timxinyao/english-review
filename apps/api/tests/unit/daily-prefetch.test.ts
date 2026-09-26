import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_APP_TIMEZONE,
  MAX_NEW_ITEMS_UNLIMITED,
  QUESTION_TARGET_STOCK,
  localDateString,
} from '@el/shared';
import { createMockProvider, type AiProvider, type ProviderRequest } from '../../src/ai/provider/index.js';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dailyStats, jobLocks, settings as settingsTable } from '../../src/db/schema.js';
import { PREFETCH_NEW_ITEMS_CAP, runPrefetch } from '../../src/jobs/daily-prefetch.js';
import { countQuestionStock } from '../../src/modules/questions/service.js';
import { buildMockRuntime, failingForTargetProvider } from '../helpers/ai';
import { seedExample, seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';

let db: AppDatabase;
const NOW = new Date('2026-09-24T08:00:00.000Z');
/** NOW 在默认时区（Asia/Shanghai）下的本地日期，daily_stats.date 归属用 */
const TODAY = localDateString(NOW, DEFAULT_APP_TIMEZONE);

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
});

function inHours(hours: number): string {
  return new Date(NOW.getTime() + hours * 3_600_000).toISOString();
}

function setMaxNewItemsPerDay(v: number): void {
  db.insert(settingsTable)
    .values({
      id: 1,
      maxNewItemsPerDay: v,
      contentLevel: 'B1',
      preferredTtsVoice: null,
      updatedAt: new Date().toISOString(),
    })
    .run();
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
  level = 2,
): Promise<string> {
  const id = await seedItem(db, { target, status: 'active', queueState: 'started', ...overrides });
  await seedExample(db, id, 'source', `An example with ${target}.`);
  await seedReviewState(db, id, dimension, { level, nextReviewAt });
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

  it('P-L3 到期 → 补 cloze(3) + production(2) 两类库存', async () => {
    const itemId = await seedDueItem('mix-3', 'production', inHours(10), {}, 3);
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);

    expect(summary).toMatchObject({ due: 1, processed: 2, failed: 0, generated: 5 });
    expect(countQuestionStock(db, itemId, 'cloze')).toBe(3);
    expect(countQuestionStock(db, itemId, 'production')).toBe(2); // QUESTION_TARGET_STOCK.production
  });

  it('P-L5 到期 → 同样补 production 库存（目标 2）', async () => {
    const itemId = await seedDueItem('late-5', 'production', inHours(20), {}, 5);
    await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);
    expect(countQuestionStock(db, itemId, 'production')).toBe(2);
  });

  it('P-L3 production 库存已达标 → 只补差额，不重复生成', async () => {
    const itemId = await seedDueItem('mix-stocked', 'production', inHours(10), {}, 3);
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
    expect(summary.processed).toBe(1); // 只剩 cloze 需要生成
    expect(summary.skipped).toBe(0);
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

describe('runPrefetch 新词队列补库存（Today Learn 题盲区）', () => {
  it('新词库存 0 → 按剩余额度补 understanding 至目标库存', async () => {
    setMaxNewItemsPerDay(10);
    const itemId = await seedNewItem('new-a', '2026-09-01T00:00:00.000Z');
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);

    expect(summary).toMatchObject({ newItems: 1, failed: 0 });
    expect(summary.newGenerated).toBeGreaterThanOrEqual(1);
    // 生成调用即 ('understanding', 3)：一次补满 QUESTION_TARGET_STOCK.understanding
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(QUESTION_TARGET_STOCK.understanding);
    expect(countQuestionStock(db, itemId, 'cloze')).toBe(0);
  });

  it('当日新词额度耗尽 → 新词不生成', async () => {
    setMaxNewItemsPerDay(10);
    db.insert(dailyStats)
      .values({
        date: TODAY,
        formalTasksCompleted: 0,
        newItemsStarted: 10,
        productionAttempts: 0,
        productionPass: 0,
        updatedAt: NOW.toISOString(),
      })
      .run();
    const itemId = await seedNewItem('new-full', '2026-09-01T00:00:00.000Z');
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);

    expect(summary).toMatchObject({ newItems: 0, newGenerated: 0 });
    expect(countQuestionStock(db, itemId, 'understanding')).toBe(0);
  });

  it('unlimited 额度 → 新词预取封顶 PREFETCH_NEW_ITEMS_CAP（第 21~25 个不生成）', async () => {
    setMaxNewItemsPerDay(MAX_NEW_ITEMS_UNLIMITED);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `cap-${String(i).padStart(2, '0')}`;
      ids.push(await seedNewItem(id, `2026-09-01T00:00:${String(i).padStart(2, '0')}.000Z`));
    }
    const summary = await runPrefetch({ db, runtime: buildMockRuntime() }, NOW);

    expect(summary.newItems).toBe(PREFETCH_NEW_ITEMS_CAP);
    expect(countQuestionStock(db, ids[0]!, 'understanding')).toBe(QUESTION_TARGET_STOCK.understanding);
    expect(countQuestionStock(db, ids[19]!, 'understanding')).toBe(QUESTION_TARGET_STOCK.understanding);
    expect(countQuestionStock(db, ids[20]!, 'understanding')).toBe(0);
    expect(countQuestionStock(db, ids[24]!, 'understanding')).toBe(0);
  });

  it('runPrefetch 整体持 question-generation 锁：执行期间锁行存在，结束后 job_locks 清空', async () => {
    setMaxNewItemsPerDay(10);
    await seedNewItem('lock-new', '2026-09-01T00:00:00.000Z');
    const inner = createMockProvider();
    // 首次 AI 调用时探针：执行期间锁行必须存在且租约未过期
    let during: { holder: string; leaseUntil: string } | undefined;
    const provider: AiProvider = {
      name: inner.name,
      async complete(req: ProviderRequest) {
        if (!during) {
          const row = db.select().from(jobLocks).where(eq(jobLocks.name, 'question-generation')).get();
          during = row ? { holder: row.holder, leaseUntil: row.leaseUntil } : undefined;
        }
        return inner.complete(req);
      },
    };
    const summary = await runPrefetch({ db, runtime: buildMockRuntime(provider) }, NOW);

    expect(summary.newItems).toBe(1); // 确保探针真的跑过
    expect(during).toBeDefined();
    expect(during?.holder).toContain(String(process.pid));
    expect(during && during.leaseUntil > new Date().toISOString()).toBe(true);
    // 释放无残留
    expect(db.select().from(jobLocks).all()).toHaveLength(0);
  });
});
