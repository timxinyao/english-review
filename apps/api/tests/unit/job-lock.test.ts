import { describe, expect, it } from 'vitest';
import { createDatabase, rawSqlite, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { JobLockTimeoutError, withJobLock } from '../../src/db/job-lock.js';

function makeDb(): AppDatabase {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('withJobLock', () => {
  it('无竞争：获取→执行→释放', async () => {
    const db = makeDb();
    const out = await withJobLock(db, 'question-generation', async () => 42);
    expect(out).toBe(42);
    const row = rawSqlite(db).prepare('SELECT COUNT(*) n FROM job_locks').get() as { n: number };
    expect(row.n).toBe(0); // 释放后无残留
  });

  it('互斥：并发两个任务串行执行（第二个等锁）', async () => {
    const db = makeDb();
    const order: string[] = [];
    const p1 = withJobLock(db, 'L', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 150));
      order.push('a-end');
    });
    const p2 = withJobLock(db, 'L', async () => {
      order.push('b-start');
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('等待超时：抛 JobLockTimeoutError 且不执行 fn', async () => {
    const db = makeDb();
    const slow = withJobLock(db, 'L', () => new Promise<void>((r) => setTimeout(r, 400)));
    await expect(
      withJobLock(db, 'L', async () => 'never', { waitTimeoutMs: 80, pollMs: 20 }),
    ).rejects.toBeInstanceOf(JobLockTimeoutError);
    await slow;
  });

  it('租约过期：崩溃残留可被接管', async () => {
    const db = makeDb();
    // 直接写入一条已过期租约（模拟持锁进程崩溃）
    const past = new Date(Date.now() - 1000).toISOString();
    rawSqlite(db)
      .prepare("INSERT INTO job_locks (name, holder, lease_until) VALUES ('L', 'ghost', ?)")
      .run(past);
    const out = await withJobLock(db, 'L', async () => 'ok', { pollMs: 20 });
    expect(out).toBe('ok');
  });

  it('fn 抛错：锁仍被释放', async () => {
    const db = makeDb();
    await expect(
      withJobLock(db, 'L', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const out = await withJobLock(db, 'L', async () => 'recovered');
    expect(out).toBe('recovered');
  });
});
