import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from './client.js';
import { jobLocks } from './schema.js';

export interface JobLockOptions {
  /** 持有租约时长（ms）：超过视为持锁进程崩溃残留，可被接管。远大于单次批量生成时长，无需续期 */
  ttlMs?: number;
  /** 等锁上限（ms）：超时抛 JobLockTimeoutError */
  waitTimeoutMs?: number;
  /** 等锁轮询间隔（ms） */
  pollMs?: number;
}

export class JobLockTimeoutError extends Error {
  constructor(
    public readonly lockName: string,
    public readonly waitedMs: number,
  ) {
    super(`job lock ${lockName} 等待超时（${waitedMs}ms）`);
    this.name = 'JobLockTimeoutError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function newHolder(): string {
  return `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

function tryAcquire(db: AppDatabase, name: string, holder: string, ttlMs: number): boolean {
  // better-sqlite3 同步事务；跨进程写锁竞争抛 SQLITE_BUSY 时按未获取处理（下轮 poll 重试）
  try {
    return db.transaction((tx) => {
      const nowIso = new Date().toISOString();
      const row = tx.select().from(jobLocks).where(eq(jobLocks.name, name)).get();
      if (row && row.leaseUntil > nowIso) return false; // 他人持有且未过期
      const leaseUntil = new Date(Date.now() + ttlMs).toISOString();
      tx.insert(jobLocks)
        .values({ name, holder, leaseUntil })
        .onConflictDoUpdate({ target: jobLocks.name, set: { holder, leaseUntil } })
        .run();
      return true;
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'SQLITE_BUSY' || e.message?.includes('database is locked')) return false;
    throw err;
  }
}

/**
 * 跨进程任务锁（SQLite 租约表）。入口级互斥：question-generation 的消费点是
 * today/start、daily-prefetch、library/practice，内部实现不得再次加锁（不可重入）。
 */
export async function withJobLock<T>(
  db: AppDatabase,
  name: string,
  fn: () => Promise<T>,
  opts: JobLockOptions = {},
): Promise<T> {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const waitTimeoutMs = opts.waitTimeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 300;
  const holder = newHolder();
  const startedAt = Date.now();
  while (!tryAcquire(db, name, holder, ttlMs)) {
    if (Date.now() - startedAt >= waitTimeoutMs) {
      throw new JobLockTimeoutError(name, Date.now() - startedAt);
    }
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    db.delete(jobLocks)
      .where(and(eq(jobLocks.name, name), eq(jobLocks.holder, holder)))
      .run();
  }
}
