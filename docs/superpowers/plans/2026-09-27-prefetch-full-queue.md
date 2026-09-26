# 预取全量新词队列 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 预取新词段覆盖整个新队列（额度解耦，病态上界 100，租约 30 分钟），使任意额度调整/加量场景零在线生成等待。

**Architecture:** 仅改 `apps/api/src/jobs/daily-prefetch.ts` 新词段与常量，及对应单测；start/额度语义不动。

**Tech Stack:** 同前（vitest，apps/api/tests/unit/daily-prefetch.test.ts）。

**规格：** `docs/superpowers/specs/2026-09-27-prefetch-full-queue-design.md`

## Global Constraints

- 仓库根：`/var/www/english-review`；API 单测：`pnpm --filter @el/api run test`（全过才算过）。
- `QUESTION_TARGET_STOCK.understanding = 3`；`PREFETCH_NEW_ITEMS_CAP = 100`；预取锁租约 `ttlMs: 30 * 60_000`。
- 提交信息末尾加：
  ```
  via [HAPI](https://hapi.run)

  Co-Authored-By: HAPI <noreply@hapi.run>
  ```
- 不要 push、不要部署、**不要手动触发预取**（编排者统一做）。

---

### Task 1: 新词段全量备货

**Files:**
- Modify: `apps/api/src/jobs/daily-prefetch.ts`
- Test: `apps/api/tests/unit/daily-prefetch.test.ts`

**Interfaces:**
- Produces: `PREFETCH_NEW_ITEMS_CAP = 100`（病态上界，导出）；`remainingNewQuota` 及额度依赖从新词段移除（可整体删除该函数）；预取租约 30 分钟。

- [ ] **Step 1: 改单测（RED）**

在 `apps/api/tests/unit/daily-prefetch.test.ts`：

1a. 原"额度耗尽不生成"用例改为（RED：现状额度耗尽会跳过）：

```ts
  it('额度耗尽仍全量备货：额度只影响当天学多少，不影响预生成', async () => {
    // seed：settings maxNewItemsPerDay=10，dailyStats(今日).newItemsStarted=10，
    // 1 个 new item、understanding 库存 0
    // 断言：summary.newItems === 1 且 generate 被调用于该 item（沿用现有用例的 seed/mock 手法）
  });
```

1b. 原"unlimited 封顶 20"用例改为：

```ts
  it('大队列按 createdAt,id 全量处理，病态上界 100', async () => {
    // seed：unlimited（或任意额度），构造 3 个 new item 全量处理 → 断言 newItems === 3、顺序按 createdAt,id
    // （>100 场景 seed 成本高，不做真实 101 个；上界逻辑以常量引用断言或代码审读为准，测试注明）
  });
```

（用例内部断言与 seed 手法沿用文件内现有模式，语义如上两条注释所述。）

- [ ] **Step 2: 跑单测确认 RED**

Run: `pnpm --filter @el/api run test -- daily-prefetch`
Expected: 1a FAIL（现状额度耗尽跳过新词）。

- [ ] **Step 3: 实现**

`apps/api/src/jobs/daily-prefetch.ts`：

3a. 常量与注释：

```ts
/** 新词预取病态上界：防单次导入巨量导致单晚跑不完（超出部分随后续夜晚追平）。
 *  额度（maxNewItemsPerDay）与备货解耦：额度只决定当天学多少。 */
export const PREFETCH_NEW_ITEMS_CAP = 100;
```

3b. 删除 `remainingNewQuota` 函数（含 MAX_NEW_ITEMS_UNLIMITED/dailyStats/settings 相关 import，若 due 段不再使用则一并清理 import）。

3c. 新词段改为全量（替换原 quota 计算与查询）：

```ts
    // ---- 新词队列全量备货（额度解耦）：按 createdAt,id 补 understanding 库存至目标 ----
    const newItems = deps.db
      .select()
      .from(learningItems)
      .where(and(eq(learningItems.status, 'active'), eq(learningItems.queueState, 'new')))
      .orderBy(asc(learningItems.createdAt), asc(learningItems.id))
      .limit(PREFETCH_NEW_ITEMS_CAP)
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
```

3d. 锁租约：`withJobLock(..., { ttlMs: 15 * 60_000 })` → `{ ttlMs: 30 * 60_000 }`，注释同步为"30 分钟租约：全量队列最多约 100 词 × 3 题串行生成"。

- [ ] **Step 4: 跑单测确认 GREEN**

Run: `pnpm --filter @el/api run test`
Expected: 全部 PASS（含既有 due 段与其他模块）。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/daily-prefetch.ts apps/api/tests/unit/daily-prefetch.test.ts
git commit -m "feat(api): 预取新词全量备货——额度解耦，病态上界100，租约30分钟

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 2: 全量验证 + 部署 + 手动全量预生成（编排者执行）

- [ ] **Step 1:** `pnpm --filter @el/api run test` 全过；`pnpm --filter @el/web run test` 全过（无 web 改动，跑一遍确认无耦合）。
- [ ] **Step 2:** 部署 `./deploy/deploy.sh`（CI=true NODE_OPTIONS 前缀），验证双入口与新 asset。
- [ ] **Step 3:** 手动触发全量预生成：`sudo systemctl start english-learning-prefetch.service`，跟踪 `journalctl -u english-learning-prefetch -f` 直至完成（预计 ≤ 10 分钟，47 词 × ~3 题），记录汇总行。
- [ ] **Step 4:** 推送 gitee。
