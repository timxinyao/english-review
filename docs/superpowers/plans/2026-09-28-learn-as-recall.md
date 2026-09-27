# 新词初见即回忆（Learn 改 Recall） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新词首触即 Recall Card（方案 A：三路径都完成新学并初始化两维，forgot 明日短间隔回归，learn 不再插同会话补强）。

**Architecture:** answerTodayTask learn 分支判定扩展（recall/hint 契约与 understanding 一致）+ 三路径统一初始化；web learn 分派 RecallCard、删 LearnContent。零 schema/调度改动。

**Tech Stack:** 同前。

**规格：** `docs/superpowers/specs/2026-09-28-learn-as-recall-design.md`

## Global Constraints

- 仓库根：`/var/www/english-review`；API/web 单测全过、双侧 typecheck。
- e2e：`E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "Today"`；1.9G 小机测试不并发。
- 三路径都消耗额度并置 started（现行为）；learn 不插补强；调度/初始化函数零改动。
- 提交信息末尾加：
  ```
  via [HAPI](https://hapi.run)

  Co-Authored-By: HAPI <noreply@hapi.run>
  ```
- 不要 push、不要部署（编排者统一做）。

---

### Task 1: API——learn 判定与统一初始化

**Files:**
- Modify: `apps/api/src/modules/today/service.ts`（answerTodayTask learn 判定/初始化/补强跳过）
- Test: today-answer 相关测试文件（新增 learn recall describe）

**Interfaces:**
- Consumes: 既有 `AnswerRequest.recall/hintUsed`（上轮已加）。
- Produces: learn 任务 POST {recall} 或 {selectedOptionId,hintUsed} 的完整语义；AnswerResponse.result/outcomeSource 同 understanding 映射。

- [ ] **Step 1: 写失败单测**

```ts
describe('learn Recall（初见即回忆，方案 A）', () => {
  it('recalled：初始化 U+P、result=pass、outcomeSource=recalled、额度+1', async () => {});
  it('forgot：同样初始化 U+P、result=fail、outcomeSource=forgot、额度+1（揭示即教学）', async () => {});
  it('hint 选对：初始化、result=basic_pass、outcomeSource=assisted', async () => {});
  it('hint 选错：初始化、result=fail、outcomeSource=forgot', async () => {});
  it('learn fail 不插入同会话补强任务', async () => {});
  it('learn 旧式纯 selectedOptionId（无 hintUsed）按 hint 语义结算', async () => {});
});
```

（seed 手法沿用现有 learn 任务构造；初始化断言查 review_states 两维行存在且 next_review_at 为明日。）

- [ ] **Step 2: RED** → Run: `pnpm --filter @el/api run test -- today-answer` → 新用例 FAIL。

- [ ] **Step 3: 实现**

3a. 判定段：`isUnderstandingRecall` 扩为 `task.taskType === 'understanding' || task.taskType === 'learn'`（变量更名 `isRecallTask` 并更新校验文案"Recall 题必须提交 recall 或 selectedOptionId"）；结果映射段 learn 与 understanding 共用同一段（recall→pass/fail；choice→assisted/forgot）——注意 learn 的 `result` 不应再走旧 `correct ? pass : fail`，把 learn 并入 isRecallTask 分支即可。

3b. 结算段 learn 分支改为：

```ts
    if (task.taskType === 'learn') {
      // Learn Recall（方案 A）：三路径都完成新学——初始化 U(L1)+P 激活；
      // forgot/assisted 的揭示即教学时刻，明日以 Recall 短间隔回归。
      writeDimState(tx, itemId, 'understanding', deps.initialUnderstandingAfterLearn(now), nowIso);
      writeDimState(tx, itemId, 'production', deps.initialProductionActivation(now), nowIso);
      tx.update(learningItems)
        .set({ queueState: 'started', updatedAt: nowIso })
        .where(eq(eq(learningItems.id, itemId))
        .run();
      bumpDailyStats(tx, session.sessionDate, { formal: 1, newItems: 1 }, nowIso);
      tx.update(reviewSessions)
        .set({ newItemsStarted: session.newItemsStarted + 1 })
        .where(eq(reviewSessions.id, session.id))
        .run();
    } else {
```

（注意 eq 单参数笔误以实际为准——照现有行原样保留，仅删除 `if (correct)` 包裹；注释同步。）

3c. 补强跳过：事务外补强预取条件与事务内插入条件都加 `task.taskType !== 'learn'`（learn 的 fail 不再需要补强题——reveal 已教学；注释一句）。

- [ ] **Step 4: GREEN + 全量** → `pnpm --filter @el/api run test` 全过（既有 learn 答错"不动 U/P"的旧用例需按新语义更新为"初始化"）。

- [ ] **Step 5: typecheck + Commit**

```bash
git add apps/api/src apps/api/tests
git commit -m "feat(api): 新词初见即回忆——learn 三路径统一初始化两维，不再插同会话补强

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 2: Web——learn 分派 RecallCard、删 LearnContent

**Files:**
- Modify: `apps/web/src/features/today/components/TaskCard.tsx`（分派含 learn；词行去重含 learn）
- Delete: `apps/web/src/features/today/components/LearnContent.tsx`
- Test: 相关 web 测试（learn 渲染/删除 LearnContent 用例）

**Interfaces:**
- Consumes: Task 1 语义；RecallCard 不改（learn 与 understanding 共用）。

- [ ] **Step 1: 改单测（RED）**：today-recall.test.tsx 增 1 用例——learn 任务渲染 RecallCard（无释义初始展示、显示答案→想起来了→POST {recall:'recalled'}）；删除/迁移 LearnContent 专属用例（grep 定位）。

- [ ] **Step 2: RED** → `cd apps/web && pnpm exec vitest run today-recall` FAIL。

- [ ] **Step 3: 实现**：TaskCard 分派条件 `'options' in question && (task.taskType === 'understanding' || task.taskType === 'learn')` → RecallCard；顶部词行去重条件含 learn；删除 LearnContent.tsx 及 import。

- [ ] **Step 4: GREEN + 全量 web 单测 + typecheck**

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src apps/web/tests
git commit -m "feat(web): 新词首触即 Recall Card——learn 分派复用，移除 LearnContent

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 3: e2e + 文档 + 全量验证（编排者执行）

- [ ] e2e：主流程 gravity Learn 段、extend 用例新词卡改 recall 路径（子代理或编排者按 diff 规模决定）；Today e2e 全过。
- [ ] docs：PRODUCT §4.2（新词第一次学习流程）与 §7.1 补"初见即回忆（方案 A）"。
- [ ] API/web 全量 + 双 typecheck + 全量 e2e ×2（幂等）+ build。
- [ ] 部署 + 双入口验证 + 推送 + 汇报。
