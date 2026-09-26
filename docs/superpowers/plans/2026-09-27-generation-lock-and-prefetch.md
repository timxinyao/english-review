# 生成全局锁 + 预取新词 + 等待弹窗 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 题目生成加跨进程全局锁（job_locks 租约）；start 生成并发 3 保序 + 三层并发安全；预取覆盖新词队列；前端开始期间弹窗等待/重试。

**Architecture:** 新 `job_locks` 表 + `withJobLock`（better-sqlite3 同步事务抢租约，跨 API/预取两进程互斥）；today/service 用 `mapLimit` 分组保序并发；IdleToday 加 portal 弹窗。锁消费点只在三个入口（start/prefetch/practice），内部不加锁。

**Tech Stack:** Fastify + drizzle + better-sqlite3、vitest（apps/api/tests）、React 18 + Tailwind v4（web）、Playwright e2e、pnpm workspace。

**规格：** `docs/superpowers/specs/2026-09-27-generation-lock-and-prefetch-design.md`

## Global Constraints

- 仓库根：`/var/www/english-review`；所有命令在根目录执行。
- API 单测：`pnpm --filter @el/api run test`（vitest run，全部通过才算过）；web 单测 `pnpm --filter @el/web run test`。
- e2e：`E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "<片段>"`（生产 API 占 5174）。
- 服务器仅 1.9G 内存：禁止单测与 e2e 并发跑；构建一律带 `NODE_OPTIONS=--max-old-space-size=768`。
- `QUESTION_TARGET_STOCK.understanding = 3`；`GENERATION_CONCURRENCY = 3`；锁名 `question-generation`；ttl 10 分钟 / 等待上限 180 秒 / 轮询 300ms。
- 前端弹窗一律 `createPortal(document.body)` + `z-overlay`（DEVELOPMENT §7）。
- 提交信息末尾加：
  ```
  via [HAPI](https://hapi.run)

  Co-Authored-By: HAPI <noreply@hapi.run>
  ```
- 不要 push、不要部署（编排者统一做）。

---

### Task 1: job_locks 表 + withJobLock 工具

**Files:**
- Modify: `apps/api/src/db/schema.ts`（新增 jobLocks 表）
- Create: `apps/api/drizzle/0003_*.sql`（drizzle-kit 生成）
- Create: `apps/api/src/db/job-lock.ts`
- Test: `apps/api/tests/unit/job-lock.test.ts`

**Interfaces:**
- Produces: `withJobLock<T>(db: AppDatabase, name: string, fn: () => Promise<T>, opts?: { ttlMs?: number; waitTimeoutMs?: number; pollMs?: number }): Promise<T>`；`JobLockTimeoutError`。表 `job_locks(name text PK, holder text NOT NULL, lease_until text NOT NULL)`。

- [ ] **Step 1: 写失败单测（unit/job-lock.test.ts）**

先看 `apps/api/tests/unit/daily-prefetch.test.ts` 开头如何建内存库（沿用同一模式建 AppDatabase 与 runMigrations），然后：

```ts
import { createDatabase, rawSqlite, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { JobLockTimeoutError, withJobLock } from '../../src/db/job-lock.js';
import { afterAll, describe, expect, it, vi } from 'vitest';

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
```

（`afterAll`/`vi` 若未用到可删 import；库句柄按现有测试模式清理，若 daily-prefetch.test 无清理惯例则不强制。）

- [ ] **Step 2: 跑单测确认失败**

Run: `pnpm --filter @el/api run test -- job-lock`
Expected: FAIL（模块不存在 / 表不存在）。

- [ ] **Step 3: 实现**

3a. `apps/api/src/db/schema.ts` 末尾追加（跟随既有表的导出风格）：

```ts
// ---------- job_locks（跨进程任务锁租约，TECHNICAL §6）----------

/** 单行租约：name 为主键；lease_until 过期视为崩溃残留可被接管 */
export const jobLocks = sqliteTable('job_locks', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  leaseUntil: text('lease_until').notNull(),
});
```

3b. 生成迁移：`pnpm --filter @el/api exec drizzle-kit generate`（在 apps/api 下有 drizzle.config.ts；生成 0003_*.sql + meta journal）。若命令不可用则按 0002 风格手写 SQL：`CREATE TABLE \`job_locks\` (\`name\` text PRIMARY KEY, \`holder\` text NOT NULL, \`lease_until\` text NOT NULL) WITHOUT ROWID;` 并补 meta/_journal.json 条目（照抄上一条目结构改 idx/tag）。

3c. 新建 `apps/api/src/db/job-lock.ts`：

```ts
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
  // better-sqlite3 同步事务：SQLite 文件写锁保证跨进程原子性
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
```

- [ ] **Step 4: 跑单测确认通过**

Run: `pnpm --filter @el/api run test -- job-lock`
Expected: 5 passed。

- [ ] **Step 5: 全量 API 单测 + Commit**

Run: `pnpm --filter @el/api run test` → 全过（迁移对既有测试无影响）。

```bash
git add apps/api/src/db apps/api/drizzle apps/api/tests/unit/job-lock.test.ts
git commit -m "feat(api): job_locks 租约表与 withJobLock——跨进程任务锁基础设施

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 2: 预取持锁 + 覆盖新词队列

**Files:**
- Modify: `apps/api/src/jobs/daily-prefetch.ts`
- Test: `apps/api/tests/unit/daily-prefetch.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `withJobLock`（锁名 `question-generation`）；`QUESTION_TARGET_STOCK`。
- Produces: `PrefetchSummary` 增加 `newItems: number; newGenerated: number`；`runPrefetch` 整体持锁执行。

- [ ] **Step 1: 改/写失败单测**

读现有 `daily-prefetch.test.ts` 的 mock/deps 模式后扩展（沿用其建库与 AI mock 手法），新增三个用例（断言细节按现有风格调整）：

1. **新词补库存**：库中 1 个 `queueState='new'` item、understanding 库存 0、settings maxNewItemsPerDay=10、当日 dailyStats 无记录 → runPrefetch 后 `summary.newItems === 1`、`newGenerated >= 1`，且生成调用参数为 `('understanding', 3)`（补至目标 3）。
2. **额度耗尽不生成**：dailyStats(今日).newItemsStarted = 10 = maxNewItemsPerDay → `newItems === 0`，generate 不被调用于新词。
3. **unlimited 上限**：maxNewItemsPerDay = -1（MAX_NEW_ITEMS_UNLIMITED），库里 25 个 new item → 取前 20 个（第 21~25 不生成）。
4. **持锁执行**：mock `withJobLock`？不改——改为断言：runPrefetch 结束后 `job_locks` 表为空，且执行期间（fn 内 probe）锁行存在（可在 AI mock 里查表验证 `lease_until > now`）。

- [ ] **Step 2: 跑单测确认失败**

Run: `pnpm --filter @el/api run test -- daily-prefetch`
Expected: 新用例 FAIL（summary 无 newItems 字段/新词不生成）。

- [ ] **Step 3: 实现**

`apps/api/src/jobs/daily-prefetch.ts`：

3a. import 区追加：

```ts
import { dailyStats, learningItems, settings as settingsTable } from '../db/schema.js';
import { withJobLock } from '../db/job-lock.js';
import { MAX_NEW_ITEMS_UNLIMITED } from '@el/shared';
```

（确认 `@el/shared` 已导出 `MAX_NEW_ITEMS_UNLIMITED`——today/service.ts:5 已在用；dailyStats 表名以 schema.ts 为准。）

3b. `PrefetchSummary` 增加字段：

```ts
  /** 新词队列补库存条目数 */
  newItems: number;
  /** 新词队列生成题目总数 */
  newGenerated: number;
```

3c. 新增常量与函数（放在 runPrefetch 上方）：

```ts
/** 新词预取上限：unlimited 或额度很大时避免单次生成过多（GLM 串行时长与服务器负载） */
export const PREFETCH_NEW_ITEMS_CAP = 20;

/** 剩余新学额度（与 today/start 同式）：maxNew - 今日 newItemsStarted */
function remainingNewQuota(db: AppDatabase, today: string): number {
  const maxNew = db.select().from(settingsTable).get()?.maxNewItemsPerDay ?? 10;
  const started = db.select().from(dailyStats).where(eq(dailyStats.date, today)).get()?.newItemsStarted ?? 0;
  if (maxNew === MAX_NEW_ITEMS_UNLIMITED) return PREFETCH_NEW_ITEMS_CAP;
  return Math.min(Math.max(0, maxNew - started), PREFETCH_NEW_ITEMS_CAP);
}
```

3d. `runPrefetch` 整体持锁，并在到期循环后追加新词段（保持既有到期逻辑原样）：

```ts
export async function runPrefetch(
  deps: { db: AppDatabase; runtime: AiRuntime },
  now: Date,
  horizonDays: number = PREFETCH_HORIZON_DAYS,
): Promise<PrefetchSummary> {
  return withJobLock(deps.db, 'question-generation', async () => {
    // ……原有 due 循环整体搬入，summary 初始化补 newItems: 0, newGenerated: 0……
    // ---- 新词队列（Today Learn 题盲区）：按剩余额度补 understanding 库存 ----
    const quota = remainingNewQuota(deps.db, localToday(now));
    if (quota > 0) {
      const newItems = deps.db
        .select()
        .from(learningItems)
        .where(and(eq(learningItems.status, 'active'), eq(learningItems.queueState, 'new')))
        .orderBy(asc(learningItems.createdAt), asc(learningItems.id))
        .limit(quota)
        .all();
      const target = QUESTION_TARGET_STOCK.understanding;
      for (const item of newItems) {
        const stock = countQuestionStock(deps.db, item.id, 'understanding');
        if (stock >= target) continue;
        try {
          const rows = await generateQuestionsForItem(
            { db: deps.db, runtime: deps.runtime },
            item.id,
            'understanding',
            target - stock,
          );
          summary.newGenerated += rows.length;
          summary.newItems++;
        } catch (err) {
          summary.failed++;
          console.error(
            `[daily-prefetch] 新词 ${item.id}（understanding）生成失败：${(err as Error).message}`,
          );
        }
      }
    }
    return summary;
  });
}
```

（`localToday(now)` = 用户本地日期字符串：用与 today/service 一致的 `localDateString(now, timezone)`——jobs 侧 config 无 timezone 时默认 Asia/Shanghai，取 `config.appTimezone`；看 daily-prefetch main 现有 config 用法后选择最简一致途径，若 main 未传 timezone 则直接用 `new Date()` 传给 localDateString 的第二参数取 config.appTimezone。实现时以 today/service.ts 的 localDateString import 路径为准。）

3e. main 的日志行追加新词段：

```ts
    console.info(
      `[daily-prefetch] 到期 ${summary.due}，处理 ${summary.processed}，` +
        `跳过 ${summary.skipped}，失败 ${summary.failed}，生成 ${summary.generated} 题；` +
        `新词 ${summary.newItems}，生成 ${summary.newGenerated} 题`,
    );
```

- [ ] **Step 4: 跑单测确认通过**

Run: `pnpm --filter @el/api run test -- daily-prefetch`
Expected: 新旧用例全过。

- [ ] **Step 5: 全量 API 单测 + Commit**

Run: `pnpm --filter @el/api run test` → 全过。

```bash
git add apps/api/src/jobs/daily-prefetch.ts apps/api/tests/unit/daily-prefetch.test.ts
git commit -m "feat(api): 预取持全局生成锁并覆盖新词队列——start 不再在线生成 Learn 题

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 3: start 持锁 + 并发 3 保序 + 三层并发安全

**Files:**
- Modify: `apps/api/src/modules/today/service.ts`
- Modify: `apps/api/src/modules/practice/service.ts`（practice 持锁）
- Test: `apps/api/tests/integration/today.test.ts`（或 unit，随现有 start 测试位置）

**Interfaces:**
- Consumes: Task 1 `withJobLock`；`GENERATION_CONCURRENCY = 3`。
- Produces: `startTodaySession` 进程内串行 + 持全局锁；due 段按 itemId 分组保序并发；`mapLimit`（模块内 helper）。

- [ ] **Step 1: 写失败单测**

在现有 today start 相关测试文件追加两个用例（沿用既有建库/seed/mock 手法）：

1a. **保序**：3 个到期 item，mock `deps.generate` 记录调用顺序并各自延迟随机（用可控 resolve 顺序：第 2 个先 resolve），断言 session 的任务顺序仍按 `next_review_at, id` 与串行实现一致（读 review_tasks 的 sortKey/taskId 序）。同时断言并发：mock generate 用一个共享计数器记录"同时在飞"峰值 ≥ 2（限 3 不足以保证 3，断言 ≥2 即可稳定）。

1b. **互斥**：先以 `withJobLock(db, 'question-generation', ...)` 占锁挂起 150ms，同时调 `startTodaySession`（seed 一个需要生成的 item），断言 start 在锁释放后才完成（用时间戳断言 start 完成 ≥ 150ms，且正常建 session 不报错）。JobLockTimeoutError 分支：占锁挂起 400ms，`startTodaySession` 应抛 CONFLICT 文案？——不：start 默认 waitTimeout 180s 会等待成功。超时分支不做 start 级测试（job-lock 单测已覆盖）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @el/api run test -- today`
Expected: 新用例 FAIL（现状串行无并发峰值 / start 不等锁）。

- [ ] **Step 3: 实现**

3a. `today/service.ts` import 区追加 `withJobLock, JobLockTimeoutError`（from '../../db/job-lock.js'）与 drizzle `asc`（若未用）。常量：

```ts
/** 在线生成并发度（预取未覆盖时的兜底路径）；GLM 串行每题约 4~5s */
const GENERATION_CONCURRENCY = 3;
```

3b. 模块内 helper（放 startTodaySession 上方）：

```ts
/** 保序并发映射：结果顺序与输入一致；任一 fn 抛错整体 reject */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
```

3c. `startTodaySession` 拆两层——外壳负责进程内串行 + 全局锁 + 超时映射：

```ts
/** 进程内串行化（双击/多标签同进程），跨进程由 uq_review_sessions_date + 全局锁兜底 */
let startChain: Promise<unknown> = Promise.resolve();

export async function startTodaySession(
  db: AppDatabase,
  deps: TodayDeps,
  timezone: string,
  now: Date,
): Promise<TodayActiveResponse | { status: 'completed'; summary: TodaySummary }> {
  const run = startChain.then(
    () => startTodaySessionLocked(db, deps, timezone, now),
    () => startTodaySessionLocked(db, deps, timezone, now),
  );
  startChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function startTodaySessionLocked(
  db: AppDatabase,
  deps: TodayDeps,
  timezone: string,
  now: Date,
): Promise<TodayActiveResponse | { status: 'completed'; summary: TodaySummary }> {
  try {
    return await withJobLock(db, 'question-generation', () =>
      startTodaySessionInner(db, deps, timezone, now),
    );
  } catch (err) {
    if (err instanceof JobLockTimeoutError) {
      throw appError('CONFLICT', '题目正在准备中，请稍候重试');
    }
    throw err;
  }
}
```

（原 `startTodaySession` 函数体整体改名为 `startTodaySessionInner`，幂等检查移到 Inner 之前？——不：幂等检查保留在 Inner 内最前（持锁后检查，语义更准）。外壳对既有测试的 `startTodaySession` 调用签名不变。）

3d. `startTodaySessionInner` 的 dueRows 段改分组保序并发（原 for 循环替换）：

```ts
  // 同 item 的多维度必须串行（防并发取到同题）；item 间并发 3；plans 顺序与串行实现一致
  const dueGroups = new Map<string, typeof dueRows>();
  for (const row of dueRows) {
    const list = dueGroups.get(row.item.id);
    if (list) list.push(row);
    else dueGroups.set(row.item.id, [row]);
  }
  const dueAcquired = await mapLimit([...dueGroups.values()], GENERATION_CONCURRENCY, async (rows) => {
    const acquired: { row: (typeof rows)[number]; taskType: 'understanding' | 'cloze' | 'production'; q: QuestionRow | null }[] = [];
    const exclude: string[] = [];
    for (const row of rows) {
      const dimension = row.state.dimension as Dimension;
      const taskType: 'understanding' | 'cloze' | 'production' =
        dimension === 'understanding'
          ? 'understanding'
          : productionQuestionTypeFor(row.item.id, row.state.level);
      const q = await acquireWithGenerate(db, deps, row.item.id, taskType, now, exclude);
      if (q) exclude.push(q.id);
      acquired.push({ row, taskType, q });
    }
    return acquired;
  });
  for (const group of dueAcquired) {
    for (const { row, taskType, q } of group) {
      if (!q) {
        console.warn(
          `[today] start 跳过到期任务：item=${row.item.id} dim=${row.state.dimension}（无可用题目）`,
        );
        continue;
      }
      markAcquired(row.item.id, q.id);
      plans.push({ itemId: row.item.id, dimension: row.state.dimension as Dimension, taskType, questionId: q.id, origin: 'base' });
    }
  }
```

（原 `markAcquired` 保留；学习段 learnItems 循环改为：）

```ts
  const learnAcquired = await mapLimit(learnItems, GENERATION_CONCURRENCY, async (item) => {
    const q = await acquireWithGenerate(db, deps, item.id, 'understanding', now);
    return { item, q };
  });
  for (const { item, q } of learnAcquired) {
    if (!q) {
      console.warn(`[today] start 跳过新项：item=${item.id}（Learn 题生成失败，不占额度）`);
      continue;
    }
    markAcquired(item.id, q.id);
    plans.push({
      itemId: item.id,
      dimension: 'understanding',
      taskType: 'learn',
      questionId: q.id,
      origin: 'base',
    });
  }
```

3e. session 插入的 UNIQUE 兜底：定位 Inner 中 `reviewSessions` 的 insert（事务内），把该事务调用包 try/catch：捕获 SQLite UNIQUE 约束错误（`err.code === 'SQLITE_CONSTRAINT_UNIQUE'` 或 message 含 `uq_review_sessions_date`）时重读当日 session 并返回 `activeResponse(db, existing)`；其他错误照抛。

3f. `practice/service.ts`：`startLibraryPractice` 的取题循环（`for (const type of wanted)`）整体包 `withJobLock(db, 'question-generation', async () => { ...原循环... })`（import from '../../db/job-lock.js'），返回值结构不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @el/api run test`
Expected: 全部 PASS（含既有 today/practice 全套——保序语义未变）。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules apps/api/tests
git commit -m "feat(api): start 持全局生成锁+并发3保序取题；practice 入锁；双开三层兜底

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 4: 前端等待弹窗

**Files:**
- Create: `apps/web/src/features/today/components/StartSessionDialog.tsx`
- Modify: `apps/web/src/features/today/components/IdleToday.tsx`
- Test: `apps/web/tests/start-session-dialog.test.tsx`

**Interfaces:**
- Consumes: `useStartSession`（现有 hook：isPending/isError/error/mutate/reset）。
- Produces: `StartSessionDialog({ pending, errorMessage, onRetry, onDismiss })`。

- [ ] **Step 1: 写失败单测（新文件 start-session-dialog.test.tsx）**

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartSessionDialog } from '../src/features/today/components/StartSessionDialog';

afterEach(cleanup);

describe('StartSessionDialog', () => {
  it('空闲：不渲染', () => {
    render(<StartSessionDialog pending={false} errorMessage={null} onRetry={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('生成中：portal 挂 body，显示等待文案，无按钮', async () => {
    render(<StartSessionDialog pending errorMessage={null} onRetry={vi.fn()} onDismiss={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: '开始今日复习' });
    await waitFor(() => expect(dialog).toBeVisible());
    expect(dialog.parentElement).toBe(document.body);
    expect(withinText(dialog)).toContain('正在准备今日题目');
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('失败：显示错误与重试；重试回调触发', async () => {
    const onRetry = vi.fn();
    render(<StartSessionDialog pending={false} errorMessage="题目正在准备中，请稍候重试" onRetry={onRetry} onDismiss={vi.fn()} />);
    expect(screen.getByText('题目正在准备中，请稍候重试')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

function withinText(el: HTMLElement): string {
  return el.textContent ?? '';
}
```

- [ ] **Step 2: 跑单测确认失败**

Run: `pnpm --filter @el/web run test -- start-session-dialog`
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现**

3a. 新建 `apps/web/src/features/today/components/StartSessionDialog.tsx`：

```tsx
import { createPortal } from 'react-dom';
import { Button } from '../../../components/ui/button';

interface Props {
  pending: boolean;
  errorMessage: string | null;
  onRetry: () => void;
  onDismiss: () => void;
}

/** 开始会话期间的全屏等待/失败弹窗（DEVELOPMENT §7：portal 到 body + z-overlay） */
export function StartSessionDialog({ pending, errorMessage, onRetry, onDismiss }: Props) {
  if (!pending && !errorMessage) return null;
  return createPortal(
    <div
      role="dialog"
      aria-label="开始今日复习"
      className="fixed inset-0 z-overlay flex items-center justify-center bg-foreground/20"
    >
      <div className="mx-5 w-full max-w-[340px] rounded-xl border border-border bg-card p-5 text-center">
        {pending ? (
          <>
            <p className="text-sm font-medium text-foreground">正在准备今日题目…</p>
            <p className="mt-2 text-xs text-muted-foreground">
              首次生成约需一分钟，请保持页面打开
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-destructive">开始失败</p>
            <p className="mt-2 text-xs text-muted-foreground">{errorMessage}</p>
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="ghost" size="sm" onClick={onDismiss}>
                关闭
              </Button>
              <Button size="sm" onClick={onRetry}>
                重试
              </Button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
```

3b. `IdleToday.tsx`：import StartSessionDialog；组件内 `const start = useStartSession();` 后渲染：

```tsx
      <StartSessionDialog
        pending={start.isPending}
        errorMessage={start.isError ? ((start.error as Error | undefined)?.message ?? '请稍候重试') : null}
        onRetry={() => start.mutate()}
        onDismiss={() => start.reset()}
      />
```

（按钮本身的 `正在开始…` 置灰行为保留不动。）

- [ ] **Step 4: 跑单测确认通过 + e2e 冒烟**

Run: `pnpm --filter @el/web run test` → 全过。
Run: `E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "Today"` → 全过（e2e 的开始流程不受弹窗影响：seed 库题目已预生成，start 秒回，弹窗一闪而过不拦截断言）。

- [ ] **Step 5: typecheck + Commit**

Run: `pnpm --filter @el/web run typecheck` → 无错误。

```bash
git add apps/web/src/features/today apps/web/tests/start-session-dialog.test.tsx
git commit -m "feat(web): 开始复习等待弹窗——生成中提示等待，失败可重试（portal+z-overlay）

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 5: 全量验证

**Files:** 无新改动（验证型任务，编排者执行）。

- [ ] **Step 1:** Run: `pnpm --filter @el/api run test` → 全过。
- [ ] **Step 2:** Run: `pnpm --filter @el/web run test` → 全过。
- [ ] **Step 3:** Run: `pnpm --filter @el/web run typecheck` → 无错误。
- [ ] **Step 4:** Run: `E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test` → 全过。
- [ ] **Step 5:** Run: `NODE_OPTIONS=--max-old-space-size=768 pnpm --filter @el/web run build` → 成功。
