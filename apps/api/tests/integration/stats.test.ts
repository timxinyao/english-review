import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { localDateString } from '@el/shared';
import type { AppDatabase } from '../../src/db/client.js';
import { dailyStats } from '../../src/db/schema.js';
import { createTestApp, loginCookie, type TestApp } from '../helpers/test-app.js';
import { seedItem } from '../helpers/seed.js';

const TZ = 'Asia/Shanghai';

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

/** 今天（APP_TIMEZONE）往前 n 天的本地日期串 */
function dateAgo(days: number): string {
  const today = localDateString(new Date(), TZ);
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** n 天前的 UTC ISO 时间戳（created_at 用） */
function isoAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function seedDaily(
  db: AppDatabase,
  date: string,
  patch: Partial<typeof dailyStats.$inferInsert> = {},
): Promise<void> {
  await db.insert(dailyStats).values({
    date,
    formalTasksCompleted: 0,
    newItemsStarted: 0,
    productionAttempts: 0,
    productionPass: 0,
    updatedAt: new Date().toISOString(),
    ...patch,
  });
}

describe('GET /api/stats', () => {
  it('totals：items/words/chunks 全量含 archived，active/mastered/paused/archived 按 status，newQueue=active 且 new', async () => {
    const { app, db, cookie } = await newApp();
    await seedItem(db, { type: 'word', status: 'active', queueState: 'new' });
    await seedItem(db, { type: 'word', status: 'active', queueState: 'started' });
    await seedItem(db, { type: 'chunk', status: 'active', queueState: 'new' });
    await seedItem(db, { type: 'word', status: 'mastered', queueState: 'started' });
    await seedItem(db, { type: 'chunk', status: 'paused', queueState: 'started' });
    await seedItem(db, { type: 'word', status: 'archived', queueState: 'new' });
    await seedItem(db, { type: 'chunk', status: 'archived', queueState: 'started' });

    const res = await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals).toEqual({
      items: 7,
      words: 4, // 全部 word（含 archived）
      chunks: 3, // 全部 chunk（含 archived）
      active: 3,
      mastered: 1,
      paused: 1,
      archived: 2,
      newQueue: 2, // active 且 queue_state=new（archived 的 new 不算）
    });
  });

  it('last7DaysFormalTasks：含今天在内 7 天求和，第 7 天前不计', async () => {
    const { app, db, cookie } = await newApp();
    await seedItem(db, {});
    await seedDaily(db, dateAgo(0), { formalTasksCompleted: 3 });
    await seedDaily(db, dateAgo(3), { formalTasksCompleted: 2 });
    await seedDaily(db, dateAgo(6), { formalTasksCompleted: 1 });
    await seedDaily(db, dateAgo(7), { formalTasksCompleted: 5 }); // 8 天窗口的第 8 天：不计
    await seedDaily(db, dateAgo(10), { formalTasksCompleted: 4 }); // 不计

    const res = await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
    expect(res.json().last7DaysFormalTasks).toBe(6);
  });

  it('production 通过率：全历史求和并计算 rate；无作答时 rate=null', async () => {
    const { app, db, cookie } = await newApp();
    await seedItem(db, {});
    await seedDaily(db, dateAgo(0), { productionAttempts: 4, productionPass: 3 });
    await seedDaily(db, dateAgo(20), { productionAttempts: 1, productionPass: 0 });

    const res = await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
    const body = res.json();
    expect(body.productionAttempts).toBe(5);
    expect(body.productionPass).toBe(3);
    expect(body.productionPassRate).toBeCloseTo(0.6, 10);
  });

  it('productionPassRate=null：daily_stats 无任何作答记录', async () => {
    const { app, cookie } = await newApp();
    const res = await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
    const body = res.json();
    expect(body.productionAttempts).toBe(0);
    expect(body.productionPass).toBe(0);
    expect(body.productionPassRate).toBeNull();
  });

  it('last30DaysNewItems：created_at 30 天内（全部状态）计数', async () => {
    const { app, db, cookie } = await newApp();
    await seedItem(db, { createdAt: isoAgo(5), updatedAt: isoAgo(5) });
    await seedItem(db, {
      createdAt: isoAgo(5),
      updatedAt: isoAgo(5),
      status: 'archived',
      archivedAt: isoAgo(1),
    });
    await seedItem(db, { createdAt: isoAgo(40), updatedAt: isoAgo(40) });

    const res = await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
    expect(res.json().last30DaysNewItems).toBe(2);
  });

  it('heatmap：长度 365、结尾为今天、零填充、已有日期取 formal_tasks_completed', async () => {
    const { app, db, cookie } = await newApp();
    await seedItem(db, {});
    const today = localDateString(new Date(), TZ);
    await seedDaily(db, dateAgo(0), { formalTasksCompleted: 3 });
    await seedDaily(db, dateAgo(1), { formalTasksCompleted: 7 });
    await seedDaily(db, dateAgo(3), { formalTasksCompleted: 2 });
    await seedDaily(db, dateAgo(364), { formalTasksCompleted: 1 }); // 窗口第一天
    await seedDaily(db, dateAgo(365), { formalTasksCompleted: 9 }); // 窗口外：不计

    const res = await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { heatmap } = res.json();
    expect(heatmap).toHaveLength(365);
    expect(heatmap[0].date).toBe(dateAgo(364)); // 旧 → 新
    expect(heatmap[364].date).toBe(today);
    expect(heatmap[364].count).toBe(3);
    expect(heatmap[363].count).toBe(7);
    expect(heatmap[362].count).toBe(0); // 昨天前一天未播种 → 0
    expect(heatmap[361].count).toBe(2);
    expect(heatmap[0].count).toBe(1);
    // 全部 count 非负整数、日期为 YYYY-MM-DD
    for (const cell of heatmap) {
      expect(cell.count).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(cell.count)).toBe(true);
      expect(cell.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('空库：全部为 0 / null，heatmap 仍为 365 天零填充', async () => {
    const { app, cookie } = await newApp();
    const res = await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
    const body = res.json();
    expect(body.totals).toEqual({
      items: 0,
      words: 0,
      chunks: 0,
      active: 0,
      mastered: 0,
      paused: 0,
      archived: 0,
      newQueue: 0,
    });
    expect(body.last7DaysFormalTasks).toBe(0);
    expect(body.last30DaysNewItems).toBe(0);
    expect(body.heatmap).toHaveLength(365);
    expect(body.heatmap.every((c: { count: number }) => c.count === 0)).toBe(true);
  });
});
