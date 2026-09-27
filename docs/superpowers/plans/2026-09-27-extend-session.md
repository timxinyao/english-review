# 同日追加学习（再学一批） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成页"再学 N 个新词"——向当天已完成会话追加一批 Learn 任务并重新激活；额度改动即时生效。

**Architecture:** 新 `extendTodaySession`（复用 start 的取词/取题片段，持生成锁）；completed 响应带 remainingNewQuota；web 完成页按钮。调度/补强/统计零改动。

**Tech Stack:** 同前。

**规格：** `docs/superpowers/specs/2026-09-27-extend-session-design.md`

## Global Constraints

- 仓库根：`/var/www/english-review`；API/web 单测全过、双侧 typecheck。
- e2e：`E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "<片段>"`；1.9G 小机测试不并发。
- 不限制模式 extend 批大小固定 10（常量 `EXTEND_BATCH_UNLIMITED = 10`）。
- 提交信息末尾加：
  ```
  via [HAPI](https://hapi.run)

  Co-Authored-By: HAPI <noreply@hapi.run>
  ```
- 不要 push、不要部署（编排者统一做）。

---

### Task 1: API——extend 端点与 remainingNewQuota

**Files:**
- Modify: `packages/shared/src/schemas/api/today.ts`（TodayCompletedResponse + ExtendRequest 无 body，无需新 schema）
- Modify: `apps/api/src/modules/today/service.ts`（extendTodaySession + completed 分支 remainingNewQuota + 复用片段）
- Modify: `apps/api/src/modules/today/routes.ts`（POST /extend 路由）
- Test: today answer/状态相关测试文件（新增 describe）

**Interfaces:**
- Produces:
  - `POST /api/today/extend` → 200 `TodayActiveResponse`；错误 `CONFLICT`（无会话/未完成/额度用尽/无新词）。
  - `TodayCompletedResponse.remainingNewQuota: number | null`（null=不限制，0=用尽）。

- [ ] **Step 1: 写失败单测（先 grep 定位 today 状态测试文件）**

```ts
describe('extendTodaySession（同日追加学习）', () => {
  it('成功：已完成会话+剩余额度 → 追加 learn 任务、completedAt 清空、返回 active', async () => {
    // seed：今日 session 已完成（completedAt 有值），maxNew=20，dailyStats.newItemsStarted=10，
    //      New Queue 有 3 个词（understanding 库存就绪）
    // 调 extendTodaySession(db, await resolveTodayDeps(), tz, now)
    // 断言：返回 status==='active'；reviewTasks 新增 3 条 taskType='learn'（sortKey 接最大值）；
    //      session.completedAt === null；再次 getTodayStatus → active
  });
  it('额度用尽 → CONFLICT "今日新学习额度已用完"', async () => {});
  it('会话未完成 → CONFLICT（active 会话无需 extend）', async () => {});
  it('不限制模式：批 10 个', async () => { /* maxNew=-1，队列 12 词 → 追加 10 */ });
  it('剩余额度小于队列：只取剩余数', async () => { /* 剩 2 → 追加 2 */ });
  it('completed 响应 remainingNewQuota：有限剩余/null 不限/0 用尽 三态', async () => {});
});
```

（seed 手法沿用该文件现有 session/task 构造 helper；若现有 helper 无"已完成会话"构造，最小新增 setup 函数。）

- [ ] **Step 2: 跑单测确认 RED**

Run: `pnpm --filter @el/api run test -- today` → 新用例 FAIL（函数不存在）。

- [ ] **Step 3: 实现**

3a. `service.ts` 新增（放在 startTodaySession 之后；复用其 learn 段手法——可把 start 内"New Queue 候选 + 额度 + acquireWithGenerate(understanding) + 插入 learn 任务"抽成模块内 helper `planLearnTasks(db, deps, now, count)` 供两处调用，避免复制）：

```ts
export const EXTEND_BATCH_UNLIMITED = 10;

/** 剩余新学额度（maxNew − 今日 newItemsStarted；不限制返回 null） */
function remainingNewQuotaOf(db: AppDatabase, sessionDate: string): number | null {
  const maxNew = readMaxNewItemsPerDay(db);
  const started = db.select().from(dailyStats).where(eq(dailyStats.date, sessionDate)).get()?.newItemsStarted ?? 0;
  if (maxNew === MAX_NEW_ITEMS_UNLIMITED) return null;
  return Math.max(0, maxNew - started);
}

/**
 * 同日追加学习（PRODUCT §3.4）：已完成会话 + 额度剩余 → 追加一批 Learn 任务并重新激活。
 * 调度/统计零改动：追加任务与正常 Learn 同路径（answer 时结算/计数/完成检测）。
 */
export async function extendTodaySession(
  db: AppDatabase,
  deps: TodayDeps,
  timezone: string,
  now: Date,
): Promise<TodayActiveResponse> {
  const today = localDateString(now, timezone);
  const session = db.select().from(reviewSessions).where(eq(reviewSessions.sessionDate, today)).get();
  if (!session) throw appError('CONFLICT', '今日没有复习会话');
  if (session.completedAt === null) throw appError('CONFLICT', '会话尚未完成，无需追加');

  const remaining = remainingNewQuotaOf(db, today);
  if (remaining === 0) throw appError('CONFLICT', '今日新学习额度已用完');
  const count = remaining ?? EXTEND_BATCH_UNLIMITED;

  const candidates = db
    .select()
    .from(learningItems)
    .where(and(eq(learningItems.status, 'active'), eq(learningItems.queueState, 'new')))
    .orderBy(asc(learningItems.createdAt), asc(learningItems.id))
    .limit(count)
    .all();
  if (candidates.length === 0) throw appError('CONFLICT', '没有可学的新词');

  return withJobLock(db, 'question-generation', async () => {
    const acquired: { itemId: string; questionId: string }[] = [];
    for (const item of candidates) {
      const q = await acquireWithGenerate(db, deps, item.id, 'understanding', now);
      if (q) acquired.push({ itemId: item.id, questionId: q.id });
      else console.warn(`[today] extend 跳过新项：item=${item.id}（Learn 题生成失败，不占额度）`);
    }
    if (acquired.length === 0) throw appError('AI_PROVIDER_ERROR', '题目生成失败，请稍后重试');

    const nowIso = now.toISOString();
    return db.transaction((tx) => {
      const fresh = tx.select().from(reviewSessions).where(eq(reviewSessions.id, session.id)).get();
      if (!fresh) throw appError('INTERNAL', '会话不存在');
      if (fresh.completedAt === null) throw appError('CONFLICT', '会话已被重新激活');
      let maxSort = tx
        .select({ m: sql<number>`max(${reviewTasks.sortKey})` })
        .from(reviewTasks)
        .where(eq(reviewTasks.sessionId, session.id))
        .get()?.m as number | undefined;
      maxSort ??= 0;
      for (const a of acquired) {
        tx.insert(reviewTasks).values({
          id: randomUUID(),
          sessionId: session.id,
          learningItemId: a.itemId,
          dimension: 'understanding',
          questionId: a.questionId,
          taskType: 'learn',
          origin: 'base',
          sortKey: ++maxSort,
          deferCount: 0,
          createdAt: nowIso,
        }).run();
      }
      tx.update(reviewSessions).set({ completedAt: null }).where(eq(reviewSessions.id, session.id)).run();
      const updated = tx.select().from(reviewSessions).where(eq(reviewSessions.id, session.id)).get()!;
      return activeResponse(tx, updated);
    });
  });
}
```

（上面 values 写法按 reviewTasks 实际列名与既有 start 插入段对齐——实施时以 startTodaySession 的插入段为模板逐字段对照，去掉示例中多余表达式；`randomUUID`/`sql` 等 import 以文件现有为准。）

3b. completed 分支补 `remainingNewQuota`：`getTodayStatus` 的 completed 返回对象（`{ status: 'completed', summary }` 处）加 `remainingNewQuota: remainingNewQuotaOf(db, today)`；shared 的 TodayCompletedResponse 加 `remainingNewQuota: z.number().int().nullable()`。TodayPage 前端 completed 分支把该值透传 CompletedToday（Task 2 用；本任务只需类型可用）。

3c. `routes.ts`：仿 start 路由加 `app.post('/extend', ...)`（登录态中间件与 start 一致），调 `extendTodaySession(db, await resolveTodayDeps(), tz, new Date())`。

- [ ] **Step 4: 跑单测确认 GREEN + 全量**

Run: `pnpm --filter @el/api run test` → 全过。

- [ ] **Step 5: typecheck + Commit**

```bash
git add packages/shared apps/api/src apps/api/tests
git commit -m "feat(api): 同日追加学习——extend 端点向已完成会话补一批 Learn，额度即时生效

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 2: Web——完成页"再学一批" + e2e

**Files:**
- Modify: `apps/web/src/features/today/api.ts`（useExtendSession hook）
- Modify: `apps/web/src/features/today/components/CompletedToday.tsx`
- Modify: `apps/web/src/features/today/TodayPage.tsx`（透传 remainingNewQuota）
- Test: `apps/web/tests/completed-today.test.tsx`（扩展）、`apps/web/e2e/today.spec.ts`（新增用例）

**Interfaces:**
- Consumes: Task 1 的 `POST /api/today/extend` 与 `remainingNewQuota`。

- [ ] **Step 1: 写失败单测（completed-today.test.tsx 扩展）**

```ts
  it('剩余额度>0：显示"再学 N 个新词"，点击 POST extend 并 invalidate', async () => {
    // stub completed 响应带 remainingNewQuota: 10；'/api/today/extend' 桩 active
    // 断言按钮可见文案"再学 10 个新词"；fireEvent.click → apiCalls('/api/today/extend') 1 次
  });
  it('remainingNewQuota=null：显示"再学 10 个新词"（不限批）', async () => {});
  it('remainingNewQuota=0：无按钮', async () => {});
  it('extend 失败：按钮下方显示错误文案，可重试', async () => { /* 桩 409 CONFLICT */ });
```

（stub 手法沿用该文件现有 completed fixture；extend 路径桩加进 stubApi。）

- [ ] **Step 2: RED** → Run: `cd apps/web && pnpm exec vitest run completed-today` → FAIL。

- [ ] **Step 3: 实现**

3a. `api.ts`：

```ts
export function useExtendSession() {
  const invalidate = useInvalidateToday();
  return useMutation({
    mutationFn: () => api('/api/today/extend', { method: 'POST' }),
    onSuccess: invalidate,
  });
}
```

（`api` 的 POST 传参签名以文件现有写法为准；`useInvalidateToday` 已存在。）

3b. `CompletedToday.tsx`：props 增 `remainingNewQuota?: number | null`；摘要区下（Read 链接后）加：

```tsx
      {renderExtend()}
```

组件内：

```tsx
  const extend = useExtendSession();
  const extendCount = remainingNewQuota ?? EXTEND_BATCH_UNLIMITED;
  // EXTEND_BATCH_UNLIMITED 常量从 @el/shared 导入（Task 1 已导出）
  function renderExtend() {
    if (remainingNewQuota === 0) return null;
    if (extend.isSuccess) return null; // invalidate 后组件将卸载，双保险
    return (
      <div className="space-y-1">
        <Button size="sm" disabled={extend.isPending} onClick={() => extend.mutate()}>
          {extend.isPending ? '正在追加…' : `再学 ${extendCount} 个新词`}
        </Button>
        {extend.isError && (
          <p className="text-xs text-destructive">{(extend.error as Error | undefined)?.message || '追加失败，请重试'}</p>
        )}
      </div>
    );
  }
```

3c. `TodayPage.tsx` completed 分支：`<CompletedToday data={data} remainingNewQuota={data.remainingNewQuota ?? undefined} />`（保持 props 可选兼容测试直渲染）。

- [ ] **Step 4: GREEN + 全量 web 单测 + typecheck**

- [ ] **Step 5: e2e 新用例（today.spec.ts）**

```ts
  test('同日追加：完成后额度剩余可再学一批', async ({ page }) => {
    test.setTimeout(120_000);
    // 登录/重置/完成整个会话（复用主流程骨架或精简驱动）→ 完成摘要出现
    // 点"再学 N 个新词" → 新 Learn 卡出现（第 X / N+ 增长）→ 做完再回完成摘要
  });
```

（驱动手法沿用主流程循环；种子默认额度 10 且主流程已学满——本用例需在 Settings 调额度（PATCH /api/settings 页面或直接 UI）或构造剩余：**简化**：重置种子后先把额度改为 20（复用 auth.spec 的 Settings 选择器手法），再完成 10 词会话 → 按钮显示"再学 10 个"。）

- [ ] **Step 6: e2e 跑通 + Commit**

Run: `E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "Today"` → 全过。

```bash
git add apps/web/src apps/web/tests apps/web/e2e
git commit -m "feat(web): 完成页再学一批——额度剩余即时追加，失败可重试

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 3: 文档 + 全量验证 + 部署（编排者执行）

- [ ] PRODUCT_DESIGN §3.4/§4.3 补"同日追加"两条说明。
- [ ] API/web 全量单测 + typecheck + 全量 e2e + build。
- [ ] 部署 + 双入口验证 + 推送。
