# Today 会话导航改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today 会话页支持全量任务列表跳做/回看、当前位置进度指示与按题完成着色、跟手 3D 翻页动画、回看显示单词行。

**Architecture:** 后端新增批量只读端点 `GET /api/today/tasks`（全部任务题面+已答结果，含撤销标记）；前端 ActiveSession 以该列表为导航主轴（cursor 模型）替换本地 history 数组；滑动动画封装为独立 SwipeDeck 组件（纯 CSS transform，无新依赖）。

**Tech Stack:** 既有栈不变：React + TanStack Query + Fastify + Zod + Drizzle/SQLite + vitest + Playwright。

**Spec:** `docs/superpowers/specs/2026-09-26-today-session-navigation-design.md`

## Global Constraints

- 门禁（AGENTS.md §9）：宣称完成前必须 `pnpm lint && pnpm typecheck && pnpm test` 通过；E2E 用 `pnpm e2e`（本计划只跑 today spec）。
- 不新增任何依赖；不引入 framer-motion 等动画库。
- 样式只用现有 token/工具类（`apps/web/src/styles/globals.css`、`cn()`）；禁止 hex 颜色。SwipeDeck 的动态 `transform`/`perspective` 内联样式是交互位移、不是视觉样式，属允许例外（记入 phase 决策）。
- TDD：每个任务先写失败测试再实现。
- 提交身份统一（仓库属 root 创建、当前用户 ubuntu，git 全局身份不符）：
  `git -c user.name="虎嗅蔷薇" -c user.email="timxinyao@gmail.com" commit ...`
  提交信息末尾附：
  ```
  via [HAPI](https://hapi.run)

  Co-Authored-By: HAPI <noreply@hapi.run>
  ```
- 服务器内存 1.9G（见 memory）：跑测试/E2E 时不要并发其他重任务（不跑构建、不并发多个 vitest）；构建一律 `NODE_OPTIONS=--max-old-space-size=1024`。
- 文档规则（AGENTS.md §11）：用户可见行为变化先改 PRODUCT_DESIGN 再改代码（Task 1 就是文档任务）。
- 单测命令模板：API 用 `pnpm --dir apps/api exec vitest run <file>`，web 用 `pnpm --dir apps/web exec vitest run <file>`（若 `pnpm --filter @el/api` 可用亦可；以 package.json 实名为准）。
- Spec 两处计划内修订（记入 phase-7 决策记录）：
  1. `SessionTaskEntry` 增加 `canceled: boolean`（spec 漏项：弹层"已撤销"标记与滑动跳过撤销任务需要）。
  2. `GET /api/today/tasks`：当日会话**已完成**时仍返回数据（最后一题反馈期间可回看）；仅**无当日会话**才 409。

---

### Task 1: 文档先行（PRODUCT §5.1 / TECHNICAL §6.2 / PHASES + phase-7 留档）

**Files:**
- Modify: `docs/PRODUCT_DESIGN.md`（§5.1，约 213 行"稍后再做"段之后）
- Modify: `docs/TECHNICAL_DESIGN.md`（§6.2 API 列表，约 188-193 行）
- Modify: `docs/PHASES.md`（阶段总览表加一行）
- Create: `docs/phases/phase-7-today-navigation.md`

**Interfaces:**
- Consumes: 无
- Produces: phase-7 留档（后续任务引用其路径）

- [ ] **Step 1: PRODUCT_DESIGN.md §5.1 增补导航规则**

在 `## 5.1 Today` 中"每道题允许'稍后再做'……"段落之后插入：

```markdown
### 会话导航与进度（V1.2 迭代：2026-09-26）

- 顶部进度指示为"第 X / N"当前位置 + 分段进度条。每个分段对应一个任务：做过的着色、没做的置灰，允许间隔（跳着做题时着色不连续）。
- 进度条弹出任务列表：显示会话全部任务的单词、题型与状态（对 / 错 / 未做 / 已撤销），全部可点——已完成的回看（只读，卡顶部显示该题单词与 IPA），未完成的直接跳去做；已撤销条目置灰不可点。
- 左滑 / 右滑（或键盘 ← / →）在会话序列中前后翻页，带跟手翻页动画；最前 / 最后边界回弹，撤销任务自动跳过。当前题右滑：已答则进入下一题，未答则为"稍后再做"。
- 桌面端无触摸时通过列表跳转与键盘导航。
```

- [ ] **Step 2: TECHNICAL_DESIGN.md §6.2 API 列表加一行**

在 `GET  /api/today` 之后加：

```text
GET  /api/today/tasks
```

- [ ] **Step 3: 创建 docs/phases/phase-7-today-navigation.md**

```markdown
# Phase 7 — Today 会话导航改版

状态：in-progress（2026-09-26 开始）
设计：docs/superpowers/specs/2026-09-26-today-session-navigation-design.md
计划：docs/superpowers/plans/2026-09-26-today-session-navigation.md

## 目标（用户四条反馈）

1. 任务列表弹层显示会话全部任务单词。
2. 滑动时进度数字反映当前位置；Anki 式跟手翻页动画。
3. 回看题卡显示考的单词（target + IPA）。
4. 进度条按"做过/没做过"着色（可间隔），允许跳着做题。

## 范围

- 后端：GET /api/today/tasks 批量只读端点；TodayActiveResponse 移除未用的 sessionTasks。
- 前端：ActiveSession cursor 导航模型、ProgressRow 重做、SwipeDeck 动画组件、TaskCard 词行、键盘导航。
- 测试：API 集成 + web 单测 + 1 条 E2E。

## 完成标准

- [ ] GET /api/today/tasks 契约与实现（含撤销任务、已完成会话、无会话 409）
- [ ] 进度条当前位置数字 + 按题完成着色（可间隔）
- [ ] 列表弹层全量任务：回看 / 跳做 / 撤销置灰
- [ ] 跟手 3D 翻页动画（reduced-motion 降级；键盘 ←/→）
- [ ] 回看/已答题卡显示单词行（target + IPA）
- [ ] 全量门禁通过（pnpm lint && pnpm typecheck && pnpm test；E2E today spec）
- [ ] 文档同步（PRODUCT §5.1、TECHNICAL §6.2）

## 决策记录

- 2026-09-26 SessionTaskEntry 增加 canceled 字段（spec 漏项：弹层"已撤销"标记与滑动跳过撤销任务需要）。
- 2026-09-26 GET /api/today/tasks 在当日会话已完成时仍返回数据（spec 修订：最后一题反馈期间可回看）；仅无当日会话 409。
- 2026-09-26 SwipeDeck 动态 transform/perspective 用内联样式：交互位移非视觉样式，属"禁止内联 style"的允许例外。

## 变更日志

- 2026-09-26：开始（设计/计划见上）。
```

- [ ] **Step 4: docs/PHASES.md 阶段总览表加行**

在 Phase 6 行之后加（先标 in-progress，Task 8 收尾改 done）：

```markdown
| 7 | Today 会话导航改版 | 全量列表跳做/回看、位置进度与按题着色、跟手翻页、回看词行 | in-progress（2026-09-26） | [phase-7-today-navigation.md](phases/phase-7-today-navigation.md) |
```

- [ ] **Step 5: Commit**

```bash
git add docs/PRODUCT_DESIGN.md docs/TECHNICAL_DESIGN.md docs/PHASES.md docs/phases/phase-7-today-navigation.md
git -c user.name="虎嗅蔷薇" -c user.email="timxinyao@gmail.com" commit -m "docs: phase-7 Today 会话导航改版——产品规则/契约/阶段留档

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 2: shared 契约变更（增 SessionTaskEntry，删 sessionTasks）

**Files:**
- Modify: `packages/shared/src/schemas/api/today.ts`
- Modify: `apps/api/src/modules/today/service.ts`（activeResponse 删 sessionTasks 块，约 693-711 行）
- Modify: `apps/web/tests/today-helpers.tsx`（makeActive 删 sessionTasks）

**Interfaces:**
- Consumes: 无
- Produces（后续任务依赖的确切类型）:
  ```ts
  export const SessionTaskEntry = z.object({
    task: TodayTaskView,
    result: AnswerResponse.nullable(),
    canceled: z.boolean(),
  });
  export type SessionTaskEntry = z.infer<typeof SessionTaskEntry>;

  export const TodaySessionTasksResponse = z.object({
    tasks: z.array(SessionTaskEntry),
  });
  export type TodaySessionTasksResponse = z.infer<typeof TodaySessionTasksResponse>;
  ```

- [ ] **Step 1: 在 today.ts 的 AnswerResponse 定义之后（约 157 行 `export type AnswerResponse = ...` 后）新增**

```ts
// ---------- 会话任务批量视图（GET /api/today/tasks）----------

export const SessionTaskEntry = z.object({
  task: TodayTaskView,
  result: AnswerResponse.nullable(),
  canceled: z.boolean(),
});
export type SessionTaskEntry = z.infer<typeof SessionTaskEntry>;

export const TodaySessionTasksResponse = z.object({
  tasks: z.array(SessionTaskEntry),
});
export type TodaySessionTasksResponse = z.infer<typeof TodaySessionTasksResponse>;
```

注意：必须放在 `AnswerResponse` 之后（zod schema 引用有 TDZ 顺序要求）。

- [ ] **Step 2: 删除 SessionTaskSummary 与 sessionTasks 字段**

删除 `packages/shared/src/schemas/api/today.ts` 中的：

```ts
export const SessionTaskSummary = z.object({
  taskId: z.string(),
  target: z.string(),
  taskType: z.enum(['learn', 'understanding', 'cloze', 'production']),
  completed: z.boolean(),
});
export type SessionTaskSummary = z.infer<typeof SessionTaskSummary>;
```

并把 `TodayActiveResponse` 中这一行删掉：

```ts
  /** 本 session 全部任务概要（单词列表弹窗用） */
  sessionTasks: z.array(SessionTaskSummary),
```

- [ ] **Step 3: service.ts activeResponse 移除 sessionTasks**

`apps/api/src/modules/today/service.ts` 的 `activeResponse` 中删除（约 693-711 行）：

```ts
    sessionTasks: exec
      .select({
        taskId: reviewTasks.id,
        target: learningItems.target,
        taskType: reviewTasks.taskType,
        completedAt: reviewTasks.completedAt,
        sortKey: reviewTasks.sortKey,
      })
      .from(reviewTasks)
      .innerJoin(learningItems, eq(reviewTasks.learningItemId, learningItems.id))
      .where(eq(reviewTasks.sessionId, session.id))
      .orderBy(asc(reviewTasks.sortKey))
      .all()
      .map((t) => ({
        taskId: t.taskId,
        target: t.target,
        taskType: t.taskType as 'learn' | 'understanding' | 'cloze' | 'production',
        completed: !!t.completedAt,
      })),
```

（若 learningItems import 因此不再使用，lint 会提示——仅当无其他使用处才删除该 import。）

- [ ] **Step 4: web 测试 helpers 同步**

`apps/web/tests/today-helpers.tsx` 的 `makeActive` 删除 `sessionTasks: [],` 一行。

- [ ] **Step 5: 全仓引用检查并验证**

```bash
grep -rn "sessionTasks\|SessionTaskSummary" apps packages --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v 'today/tasks'
pnpm typecheck
```

Expected: grep 无残留输出（`/api/today/tasks` 端点 Task 3 才实现）；typecheck 通过。

- [ ] **Step 6: 跑受影响测试**

```bash
pnpm --dir apps/api exec vitest run tests/unit/today-later-bad-feedback.test.ts tests/unit/session.test.ts
pnpm --dir apps/web exec vitest run tests/today-active.test.tsx
```

Expected: 全部 PASS（若失败，多为仍断言 sessionTasks 的旧测试——更新断言而非恢复字段）。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/schemas/api/today.ts apps/api/src/modules/today/service.ts apps/web/tests/today-helpers.tsx
git -c user.name="虎嗅蔷薇" -c user.email="timxinyao@gmail.com" commit -m "refactor(shared): 移除未用的 sessionTasks 概要，新增 SessionTaskEntry 批量契约

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 3: API getSessionTasks + 路由（TDD）

**Files:**
- Test: `apps/api/tests/unit/today-session-tasks.test.ts`（新建）
- Modify: `apps/api/src/modules/today/service.ts`
- Modify: `apps/api/src/modules/today/routes.ts`

**Interfaces:**
- Consumes: `replayAnswer(exec, task)`（service.ts 内已有，1093 行）、`taskToView(exec, task)`（522 行）。
- Produces:
  ```ts
  // service.ts
  export function getSessionTasks(
    db: AppDatabase,
    timezone: string,
    now: Date,
  ): TodaySessionTasksResponse
  // routes.ts
  app.get('/api/today/tasks', ...)
  ```

- [ ] **Step 1: 写失败测试**

新建 `apps/api/tests/unit/today-session-tasks.test.ts`（复用 today-answer.test.ts 的 seed/fake 模式）：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { createDatabase, type AppDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { reviewTasks } from '../../src/db/schema.js';
import {
  answerTodayTask,
  deferTodayTask,
  getSessionTasks,
  reportBadQuestion,
  startTodaySession,
  type TodayDeps,
} from '../../src/modules/today/service.js';
import { seedItem, seedQuestion, seedReviewState } from '../helpers/seed.js';
import { choicePayload, createFakeDeps, DEFAULT_OPTIONS } from '../helpers/today-fakes.js';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-09-24T02:00:00.000Z');

let db: AppDatabase;
let deps: TodayDeps;

beforeEach(() => {
  db = createDatabase(':memory:');
  runMigrations(db);
  deps = createFakeDeps();
});

async function seedDueChoiceItem(itemId: string): Promise<string> {
  await seedItem(db, { id: itemId, target: itemId, queueState: 'started' });
  await seedReviewState(db, itemId, 'understanding', {
    level: 3,
    nextReviewAt: '2026-09-23T00:00:00.000Z',
  });
  await seedQuestion(db, itemId, {
    type: 'understanding',
    payloadJson: choicePayload(DEFAULT_OPTIONS, '解释文本'),
    correctOptionId: 'o1',
    contextText: 'A ____ sentence.',
    promptText: `${itemId} 在这里最接近什么意思？`,
  });
  return itemId;
}

async function startSession(): Promise<string> {
  const res = await startTodaySession(db, deps, TZ, NOW);
  if (res.status !== 'active') throw new Error(`start 失败：${res.status}`);
  return res.session.id;
}

function orderedTasks(): Array<typeof reviewTasks.$inferSelect> {
  return db.select().from(reviewTasks).orderBy(asc(reviewTasks.sortKey)).all();
}

describe('getSessionTasks（GET /api/today/tasks）', () => {
  it('无当日会话 → CONFLICT', async () => {
    await expect(getSessionTasks(db, TZ, NOW)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('活跃会话：按 sortKey 顺序；未完成 result 为 null 且 canceled=false；已完成带首次结果摘要', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await startSession();
    const first = orderedTasks()[0]!;
    await answerTodayTask(db, deps, TZ, NOW, first.id, { selectedOptionId: 'o1' });

    const res = await getSessionTasks(db, TZ, NOW);
    expect(res.tasks.map((e) => e.task.taskId)).toEqual(orderedTasks().map((t) => t.id));

    const answered = res.tasks.find((e) => e.task.taskId === first.id)!;
    expect(answered.canceled).toBe(false);
    expect(answered.result?.alreadyCompleted).toBe(true);
    expect(answered.result?.correct).toBe(true);

    const pending = res.tasks.find((e) => e.task.taskId !== first.id)!;
    expect(pending.result).toBeNull();
    expect(pending.canceled).toBe(false);
    expect(pending.task.item.target).toBeTruthy();
  });

  it('已撤销任务：条目仍在、canceled=true、result 为 null', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await startSession();
    const first = orderedTasks()[0]!;
    await answerTodayTask(db, deps, TZ, NOW, first.id, { selectedOptionId: 'o2' }); // 答错
    reportBadQuestion(db, first.id, NOW); // 撤销

    const res = await getSessionTasks(db, TZ, NOW);
    const canceled = res.tasks.find((e) => e.task.taskId === first.id)!;
    expect(canceled.canceled).toBe(true);
    expect(canceled.result).toBeNull();
  });

  it('稍后再做改变顺序：defer 后该任务移到列表末尾', async () => {
    await seedDueChoiceItem('item-a');
    await seedDueChoiceItem('item-b');
    await seedDueChoiceItem('item-c');
    await startSession();
    const first = orderedTasks()[0]!;
    deferTodayTask(db, first.id);

    const res = await getSessionTasks(db, TZ, NOW);
    expect(res.tasks[res.tasks.length - 1]!.task.taskId).toBe(first.id);
  });

  it('当日会话已完成：仍返回任务列表（最后一题反馈期间可回看）', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const only = orderedTasks()[0]!;
    await answerTodayTask(db, deps, TZ, NOW, only.id, { selectedOptionId: 'o1' });

    const res = await getSessionTasks(db, TZ, NOW);
    expect(res.tasks).toHaveLength(1);
    expect(res.tasks[0]!.result?.correct).toBe(true);
  });

  it('重复调用幂等（相同返回）', async () => {
    await seedDueChoiceItem('item-a');
    await startSession();
    const a = await getSessionTasks(db, TZ, NOW);
    const b = await getSessionTasks(db, TZ, NOW);
    expect(a).toEqual(b);
  });
});
```

（若 `AppError` 无 `code` 属性，先看 `apps/api/src/lib/errors.ts` 的实际字段名再调整断言。）

- [ ] **Step 2: 运行确认失败**

```bash
pnpm --dir apps/api exec vitest run tests/unit/today-session-tasks.test.ts
```

Expected: FAIL（`getSessionTasks` 未导出 / import 报错）。

- [ ] **Step 3: 实现 getSessionTasks**

`apps/api/src/modules/today/service.ts`：

1. `@el/shared` import 列表加 `type TodaySessionTasksResponse`。
2. 在 `getTodayStatus`（约 785 行）之前新增：

```ts
// ---------------------------------------------------------------------------
// GET /api/today/tasks：会话全部任务批量视图（导航/回看/跳做）
// ---------------------------------------------------------------------------

export function getSessionTasks(
  db: AppDatabase,
  timezone: string,
  now: Date,
): TodaySessionTasksResponse {
  const today = localDateString(now, timezone);
  const session = db
    .select()
    .from(reviewSessions)
    .where(eq(reviewSessions.sessionDate, today))
    .get();
  if (!session) throw appError('CONFLICT', '今日没有复习会话');
  const tasks = db
    .select()
    .from(reviewTasks)
    .where(eq(reviewTasks.sessionId, session.id))
    .orderBy(asc(reviewTasks.sortKey))
    .all();
  return {
    tasks: tasks.map((task) => ({
      task: taskToView(db, task),
      result: task.completedAt !== null ? replayAnswer(db, task) : null,
      canceled: task.canceledAt !== null,
    })),
  };
}
```

- [ ] **Step 4: 注册路由**

`apps/api/src/modules/today/routes.ts`：import 列表加 `getSessionTasks`，在 `app.get('/api/today', ...)` 之后加：

```ts
  app.get('/api/today/tasks', async () => getSessionTasks(db, tz, new Date()));
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm --dir apps/api exec vitest run tests/unit/today-session-tasks.test.ts
```

Expected: 6 个用例全 PASS。

- [ ] **Step 6: 回归 API 全量**

```bash
pnpm --dir apps/api exec vitest run
```

Expected: 全部 PASS（391+ 用例）。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/today/service.ts apps/api/src/modules/today/routes.ts apps/api/tests/unit/today-session-tasks.test.ts
git -c user.name="虎嗅蔷薇" -c user.email="timxinyao@gmail.com" commit -m "feat(api): GET /api/today/tasks 批量返回会话任务题面与首次结果

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 4: SwipeDeck 跟手翻页组件（TDD）

**Files:**
- Create: `apps/web/src/features/today/components/SwipeDeck.tsx`
- Test: `apps/web/tests/swipe-deck.test.tsx`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  ```tsx
  export function SwipeDeck({
    onSwipeLeft,
    onSwipeRight,
    children,
  }: {
    onSwipeLeft: () => boolean | void;
    onSwipeRight: () => boolean | void;
    children: ReactNode;
  }): JSX.Element
  // handler 返回 false = 边界回弹（不播放翻页动画）；内部可滑动 div 带 data-swipe-deck 属性
  ```

- [ ] **Step 1: 写失败测试**

新建 `apps/web/tests/swipe-deck.test.tsx`：

```tsx
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SwipeDeck } from '../src/features/today/components/SwipeDeck';

afterEach(cleanup);

function deck(): HTMLElement {
  const el = document.querySelector('[data-swipe-deck]');
  if (!(el instanceof HTMLElement)) throw new Error('deck 未渲染');
  return el;
}

function swipeBy(dx: number, dy = 0): void {
  const el = deck();
  fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 200 + dx / 2, clientY: 300 + dy }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
}

describe('SwipeDeck', () => {
  it('渲染 children', () => {
    render(
      <SwipeDeck onSwipeLeft={vi.fn()} onSwipeRight={vi.fn()}>
        <p>卡片内容</p>
      </SwipeDeck>,
    );
    expect(document.querySelector('[data-swipe-deck]')?.textContent).toContain('卡片内容');
  });

  it('左滑超过阈值 → onSwipeLeft 调用一次', () => {
    const left = vi.fn();
    render(
      <SwipeDeck onSwipeLeft={left} onSwipeRight={vi.fn()}>
        <p>卡</p>
      </SwipeDeck>,
    );
    swipeBy(-120);
    expect(left).toHaveBeenCalledTimes(1);
  });

  it('右滑超过阈值 → onSwipeRight 调用一次', () => {
    const right = vi.fn();
    render(
      <SwipeDeck onSwipeLeft={vi.fn()} onSwipeRight={right}>
        <p>卡</p>
      </SwipeDeck>,
    );
    swipeBy(120);
    expect(right).toHaveBeenCalledTimes(1);
  });

  it('位移不足阈值 → 不触发回调', () => {
    const left = vi.fn();
    render(
      <SwipeDeck onSwipeLeft={left} onSwipeRight={vi.fn()}>
        <p>卡</p>
      </SwipeDeck>,
    );
    swipeBy(-40);
    expect(left).not.toHaveBeenCalled();
  });

  it('垂直主导的滑动 → 不触发回调', () => {
    const left = vi.fn();
    render(
      <SwipeDeck onSwipeLeft={left} onSwipeRight={vi.fn()}>
        <p>卡</p>
      </SwipeDeck>,
    );
    fireEvent.touchStart(deck(), { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(deck(), { touches: [{ clientX: 210, clientY: 420 }] });
    fireEvent.touchEnd(deck(), { changedTouches: [{ clientX: 212, clientY: 480 }] });
    expect(left).not.toHaveBeenCalled();
  });

  it('handler 返回 false → 不抛错（边界回弹）', () => {
    const left = vi.fn(() => false);
    render(
      <SwipeDeck onSwipeLeft={left} onSwipeRight={vi.fn()}>
        <p>卡</p>
      </SwipeDeck>,
    );
    expect(() => swipeBy(-120)).not.toThrow();
    expect(left).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm --dir apps/web exec vitest run tests/swipe-deck.test.tsx
```

Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现 SwipeDeck**

新建 `apps/web/src/features/today/components/SwipeDeck.tsx`：

```tsx
import { useRef, type ReactNode } from 'react';

const THRESHOLD_PX = 60;
/** 水平判定比例：|dx| 必须超过 |dy| 的 1.5 倍 */
const H_RATIO = 1.5;

interface SwipeDeckProps {
  onSwipeLeft: () => boolean | void;
  onSwipeRight: () => boolean | void;
  children: ReactNode;
}

/**
 * 跟手 3D 翻页容器：水平滑动时卡片跟随手指位移 + 轻微 rotateY；
 * 松手超过阈值翻页（先滑出再换内容、新卡从对侧滑入），否则回弹。
 * handler 返回 false = 边界，直接回弹不翻页。
 * prefers-reduced-motion 时跳过所有动画，仅保留手势判定。
 */
export function SwipeDeck({ onSwipeLeft, onSwipeRight, children }: SwipeDeckProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setTransform(dx: number, animated: boolean, ms = 200) {
    const el = cardRef.current;
    if (!el) return;
    el.style.transition = animated ? `transform ${ms}ms ease-out` : 'none';
    el.style.transform = dx === 0 ? '' : `translateX(${dx}px) rotateY(${dx * 0.06}deg)`;
  }

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    start.current = { x: t.clientX, y: t.clientY };
    dragging.current = false;
    if (!reducedMotion) setTransform(0, false);
  }

  function onTouchMove(e: React.TouchEvent) {
    if (!start.current) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - start.current.x;
    const dy = t.clientY - start.current.y;
    if (!dragging.current) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * H_RATIO) return;
      dragging.current = true;
    }
    if (!reducedMotion) setTransform(dx, false);
  }

  function onTouchEnd(e: React.TouchEvent) {
    const s = start.current;
    if (!s) return;
    start.current = null;
    const t = e.changedTouches[0];
    const dx = t ? t.clientX - s.x : 0;
    const dy = t ? t.clientY - s.y : 0;
    const isSwipe =
      dragging.current && Math.abs(dx) > THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * H_RATIO;
    dragging.current = false;

    if (!isSwipe) {
      if (!reducedMotion) setTransform(0, true);
      return;
    }
    const handled = dx < 0 ? onSwipeLeft() : onSwipeRight();
    if (handled === false || reducedMotion) {
      if (!reducedMotion) setTransform(0, true);
      return;
    }
    // 滑出 → 换内容 → 新卡从对侧滑入
    const out = dx < 0 ? -(window.innerWidth ?? 400) : window.innerWidth ?? 400;
    setTransform(out, true, 250);
    window.setTimeout(() => {
      setTransform(dx < 0 ? 60 : -60, false);
      requestAnimationFrame(() => setTransform(0, true, 200));
    }, 250);
  }

  return (
    <div style={{ perspective: '1200px' }}>
      <div
        ref={cardRef}
        data-swipe-deck
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{ willChange: 'transform', backfaceVisibility: 'hidden' }}
      >
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm --dir apps/web exec vitest run tests/swipe-deck.test.tsx
```

Expected: 6 个用例全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/today/components/SwipeDeck.tsx apps/web/tests/swipe-deck.test.tsx
git -c user.name="虎嗅蔷薇" -c user.email="timxinyao@gmail.com" commit -m "feat(web): SwipeDeck 跟手 3D 翻页容器（无依赖，reduced-motion 降级）

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 5: TaskCard 回看词行（TDD）

**Files:**
- Modify: `apps/web/src/features/today/components/TaskCard.tsx`
- Test: `apps/web/tests/task-card-word-row.test.tsx`（新建）

**Interfaces:**
- Consumes: `TaskCard` 现有 props（task/result/readOnly）。
- Produces: 行为——非 learn 卡在 `result != null || readOnly` 时顶部显示 target（word 加 IPA）；learn 卡不变。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/tests/task-card-word-row.test.tsx`：

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskCard } from '../src/features/today/components/TaskCard';
import {
  makeChoiceTask,
  makeCorrectAnswer,
  makeLearnTask,
} from './today-helpers';

afterEach(cleanup);

describe('TaskCard 词行（已答/回看显示单词）', () => {
  it('已答的非 learn 卡显示 target + IPA', () => {
    render(
      <TaskCard task={makeChoiceTask()} result={makeCorrectAnswer()} onAnswered={() => {}} onAdvance={() => {}} />,
    );
    expect(screen.getByRole('heading', { name: 'stable' })).toBeVisible();
    expect(screen.getByText('/ˈsteɪbl/')).toBeVisible();
  });

  it('未作答的非 learn 卡不显示词行（避免剧透）', () => {
    render(
      <TaskCard task={makeChoiceTask()} result={null} onAnswered={() => {}} onAdvance={() => {}} />,
    );
    expect(screen.queryByRole('heading', { name: 'stable' })).not.toBeInTheDocument();
  });

  it('chunk 无 IPA：只显示 target', () => {
    const task = makeChoiceTask({
      item: { id: 'i', type: 'chunk', target: 'give up', meaning: '放弃', ipa: null },
    });
    render(<TaskCard task={task} result={makeCorrectAnswer()} onAnswered={() => {}} onAdvance={() => {}} />);
    expect(screen.getByRole('heading', { name: 'give up' })).toBeVisible();
  });

  it('learn 卡不重复渲染词行（LearnContent 已有）', () => {
    render(
      <TaskCard task={makeLearnTask()} result={null} onAnswered={() => {}} onAdvance={() => {}} />,
    );
    expect(screen.getAllByRole('heading', { name: 'gravity' })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm --dir apps/web exec vitest run tests/task-card-word-row.test.tsx
```

Expected: 第 1、3 用例 FAIL（无词行）。

- [ ] **Step 3: 实现词行**

`apps/web/src/features/today/components/TaskCard.tsx` 中，在 `{task.taskType === 'learn' ? (` 分支之前插入：

```tsx
      {/* 回看/已答：顶部显示考的单词（learn 卡已有词行，不重复） */}
      {(result !== null || readOnly) && task.taskType !== 'learn' && (
        <div className="mb-3 flex items-baseline gap-2 pr-12">
          <h3 className="text-lg font-semibold text-foreground">{task.item.target}</h3>
          {task.item.type === 'word' && task.item.ipa !== null && (
            <span className="text-sm text-muted-foreground">{task.item.ipa}</span>
          )}
        </div>
      )}
```

（`pr-12` 给右上角"坏题"按钮让位。）

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm --dir apps/web exec vitest run tests/task-card-word-row.test.tsx
```

Expected: 4 个用例全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/today/components/TaskCard.tsx apps/web/tests/task-card-word-row.test.tsx
git -c user.name="虎嗅蔷薇" -c user.email="timxinyao@gmail.com" commit -m "feat(web): 回看/已答题卡顶部显示单词行（target+IPA，不剧透未答题）

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 6: ActiveSession 重构（cursor 导航 + 全量列表 + 进度着色 + 键盘）

**Files:**
- Modify: `apps/web/src/features/today/api.ts`（todayKeys.tasks + fetchSessionTasks + useSessionTasks）
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx`（整体重写导航部分）
- Modify: `apps/web/tests/today-helpers.tsx`（stubApi 默认桩 + makeSessionEntry/makeTasksResponse）
- Test: `apps/web/tests/today-navigation.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 2 的 `SessionTaskEntry`、Task 4 的 `SwipeDeck`、Task 5 的词行。
- Produces:
  ```ts
  // api.ts
  export const todayKeys = {
    all: ['today'] as const,
    status: ['today', 'status'] as const,
    tasks: ['today', 'tasks'] as const,
  };
  export function fetchSessionTasks(): Promise<TodaySessionTasksResponse>
  export function useSessionTasks(): UseQueryResult<TodaySessionTasksResponse>
  ```
  DOM 契约（测试依赖）：进度段 `data-seg="done"|"todo"`、`data-current="true|false"`；滑动容器 `[data-swipe-deck]`；弹层 `role="dialog" aria-label="任务列表"`；数字文本 `第 X / N`。

- [ ] **Step 1: api.ts 增加批量查询**

`apps/web/src/features/today/api.ts`：

1. import type 增加 `TodaySessionTasksResponse`。
2. todayKeys 增加 `tasks: ['today', 'tasks'] as const,`。
3. 在 `fetchTodayStatus` 后新增：

```ts
export function fetchSessionTasks(): Promise<TodaySessionTasksResponse> {
  return api<TodaySessionTasksResponse>('/api/today/tasks');
}
```

4. 在 `useTodayStatus` 后新增：

```ts
export function useSessionTasks() {
  return useQuery({ queryKey: todayKeys.tasks, queryFn: fetchSessionTasks });
}
```

（`todayKeys.all` invalidate 已覆盖 tasks key，作答/稍后/坏题后自动刷新。）

- [ ] **Step 2: helpers 增加默认桩与 fixture**

`apps/web/tests/today-helpers.tsx`：

1. import type 增加 `SessionTaskEntry, TodaySessionTasksResponse`。
2. `stubApi` 的 mockImplementation 开头改为：

```ts
    if (handlers[path] === undefined && path === '/api/today/tasks') {
      // 默认空批量：ActiveSession 挂载即请求；显式桩见 today-navigation.test
      return Promise.resolve({ tasks: [] });
    }
```

3. 文件末尾新增：

```ts
export function makeSessionEntry(
  task: TodayTaskView,
  result: AnswerResponse | null,
  canceled = false,
): SessionTaskEntry {
  return { task, result, canceled };
}

export function makeTasksResponse(tasks: SessionTaskEntry[]): TodaySessionTasksResponse {
  return { tasks };
}
```

- [ ] **Step 3: 写失败测试**

新建 `apps/web/tests/today-navigation.test.tsx`：

```tsx
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiCalls,
  makeActive,
  makeChoiceTask,
  makeCorrectAnswer,
  makeSessionEntry,
  makeTasksResponse,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
} from './today-helpers';

afterEach(cleanup);

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

/** 会话 fixture：t1 对、t2 错、t3 当前未做（与 /api/today.currentTask 一致）、t4 未做 */
const t1 = makeChoiceTask({ taskId: 'task-1', item: { id: 'i1', type: 'word', target: 'alpha', meaning: '甲', ipa: null } });
const t2 = makeChoiceTask({ taskId: 'task-2', item: { id: 'i2', type: 'word', target: 'beta', meaning: '乙', ipa: '/beta/' } });
const t3 = makeChoiceTask({ taskId: 'task-3', item: { id: 'i3', type: 'word', target: 'gamma', meaning: '丙', ipa: null } });
const t4 = makeChoiceTask({ taskId: 'task-4', item: { id: 'i4', type: 'word', target: 'delta', meaning: '丁', ipa: null } });

function stubSession() {
  stubApi({
    '/api/today': makeActive(t3, { completed: 2, total: 4 }),
    '/api/today/tasks': makeTasksResponse([
      makeSessionEntry(t1, makeCorrectAnswer()),
      makeSessionEntry(t2, makeWrongAnswer()),
      makeSessionEntry(t3, null),
      makeSessionEntry(t4, null),
    ]),
  });
}

function swipeBy(dx: number): void {
  const el = document.querySelector('[data-swipe-deck]');
  if (!(el instanceof HTMLElement)) throw new Error('deck 未渲染');
  fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 200 + dx / 2, clientY: 300 }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 200 + dx, clientY: 300 }] });
}

describe('Today 会话导航', () => {
  beforeEach(() => vi.clearAllMocks());

  it('进度：当前位置数字 第 3 / 4；完成段着色、未完成灰、当前段高亮', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    expect(document.querySelectorAll('[data-seg="done"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-seg="todo"]')).toHaveLength(2);
    const current = document.querySelector('[data-current="true"]');
    expect(current).not.toBeNull();
    expect(current!.getAttribute('data-seg')).toBe('todo');
  });

  it('左滑回看：数字变 第 2 / 4，卡片只读且显示单词行', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    swipeBy(-120);
    await screen.findByText('第 2 / 4');
    expect(screen.getByRole('heading', { name: 'beta' })).toBeVisible();
    // 只读：选项禁用
    const option = screen.getByRole('button', { name: '稳定的' });
    expect(option).toBeDisabled();
  });

  it('列表弹层：显示全部 4 个任务与状态；点未完成任务跳去做并可作答', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const dialog = screen.getByRole('dialog', { name: '任务列表' });
    await waitFor(() => expect(dialog).toBeVisible());
    for (const w of ['alpha', 'beta', 'gamma', 'delta']) {
      expect(dialog.getByText(w)).toBeVisible();
    }
    expect(dialog.getByText('对')).toBeVisible();
    expect(dialog.getByText('错')).toBeVisible();
    expect(dialog.getByText('当前')).toBeVisible();
    expect(dialog.getByText('未做')).toBeVisible();

    fireEvent.click(dialog.getByRole('button', { name: /delta/ }));
    await screen.findByText('第 4 / 4');
    // 跳到的未完成任务可作答：选项可点并提交该 taskId
    stubApi({
      '/api/today': makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, makeCorrectAnswer()),
        makeSessionEntry(t2, makeWrongAnswer()),
        makeSessionEntry(t3, null),
        makeSessionEntry(t4, null),
      ]),
      '/api/today/tasks/task-4/answer': makeCorrectAnswer(),
    });
    fireEvent.click(screen.getByRole('button', { name: '稳定的' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-4/answer')).toHaveLength(1);
    });
  });

  it('已撤销任务：弹层置灰不可点，滑动跳过', async () => {
    stubApi({
      '/api/today': makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, makeCorrectAnswer()),
        makeSessionEntry(t2, makeWrongAnswer()),
        makeSessionEntry(t3, null, true), // 假设 t3 被撤销（fixture 便于触发）
        makeSessionEntry(t4, null),
      ]),
    });
    renderTodayApp();
    await screen.findByText(/\/ 4/);
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const dialog = screen.getByRole('dialog', { name: '任务列表' });
    const canceledBtn = dialog.getByRole('button', { name: /gamma/ });
    expect(canceledBtn).toBeDisabled();
    fireEvent.click(canceledBtn);
    expect(screen.queryByRole('dialog', { name: '任务列表' })).toBeVisible(); // 未关闭=未跳转
  });

  it('当前题未作答右滑 → 稍后再做（later 调用，回归）', async () => {
    stubApi({
      '/api/today': makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, makeCorrectAnswer()),
        makeSessionEntry(t2, makeWrongAnswer()),
        makeSessionEntry(t3, null),
        makeSessionEntry(t4, null),
      ]),
      '/api/today/tasks/task-3/later': { ok: true, progress: { completed: 2, total: 4 } },
    });
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    swipeBy(120);
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-3/later')).toHaveLength(1);
    });
  });

  it('键盘 ← 回看、→ 返回当前', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await screen.findByText('第 2 / 4');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await screen.findByText('第 3 / 4');
  });
});
```

- [ ] **Step 4: 运行确认失败**

```bash
pnpm --dir apps/web exec vitest run tests/today-navigation.test.tsx
```

Expected: FAIL（数字是 "2 / 4" 旧样式、无 data-seg、无批量请求等）。

- [ ] **Step 5: 重写 ActiveSession**

`apps/web/src/features/today/components/ActiveSession.tsx` 整体替换为：

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AnswerResponse, SessionTaskEntry, TodayProgress, TodayTaskView } from '@el/shared';
import { Check, ChevronLeft, X } from 'lucide-react';
import { CORRECT_AUTO_ADVANCE_MS } from '../../../lib/questions';
import { cn } from '../../../lib/utils';
import { SwipeDeck } from './SwipeDeck';
import { TaskCard } from './TaskCard';
import { useLater, useSessionTasks } from '../api';

export { CORRECT_AUTO_ADVANCE_MS };

const MANUAL_ADVANCE_TYPES: ReadonlySet<TodayTaskView['taskType']> = new Set([
  'cloze',
  'production',
]);

const TYPE_LABEL: Record<TodayTaskView['taskType'], string> = {
  learn: 'learn',
  understanding: '理解',
  cloze: '填空',
  production: '表达',
};

export interface FrozenAnswer {
  task: TodayTaskView;
  result: AnswerResponse;
}

/** 进度行：当前位置数字 + 按题完成着色分段 + 全量任务弹层 */
function ProgressRow({
  progress,
  entries,
  currentIdx,
  shownIdx,
  onJump,
}: {
  progress: TodayProgress | null;
  entries: SessionTaskEntry[] | null;
  currentIdx: number | null;
  shownIdx: number | null;
  onJump: (index: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasEntries = !!entries && entries.length > 0;
  const position = hasEntries && shownIdx !== null ? shownIdx + 1 : null;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        className="flex w-full items-center justify-between"
        onClick={() => setOpen(true)}
        aria-label="查看任务列表"
      >
        <p className="text-xs text-muted-foreground">
          {position !== null
            ? `第 ${position} / ${entries!.length}`
            : progress
              ? `${progress.completed} / ${progress.total}`
              : ''}
        </p>
        <p className="text-xs text-muted-foreground/60">列表 ▾</p>
      </button>
      {hasEntries ? (
        <div className="flex gap-0.5" aria-hidden>
          {entries!.map((e, i) => (
            <span
              key={e.task.taskId}
              data-seg={e.result ? 'done' : 'todo'}
              data-current={i === shownIdx}
              className={cn(
                'flex-1 rounded-full',
                i === shownIdx ? 'h-1.5' : 'h-1',
                e.result ? 'bg-accent' : 'bg-muted',
              )}
            />
          ))}
        </div>
      ) : (
        progress &&
        progress.total > 0 && (
          <div className="flex gap-0.5" aria-hidden>
            {Array.from({ length: progress.total }, (_, i) => (
              <span
                key={i}
                className={cn('h-1 flex-1 rounded-full', i < progress.completed ? 'bg-accent' : 'bg-muted')}
              />
            ))}
          </div>
        )
      )}

      {open && (
        <div
          role="dialog"
          aria-label="任务列表"
          className="fixed inset-0 z-40 flex items-end justify-center bg-foreground/20"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[60vh] w-full max-w-[420px] overflow-y-auto rounded-t-xl border-t border-border bg-card p-4 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-3 text-sm font-medium">任务列表</p>
            <ul className="space-y-1">
              {entries?.map((e, i) => {
                const isCurrent = i === currentIdx;
                const status = e.canceled
                  ? '已撤销'
                  : e.result
                    ? e.result.correct
                      ? '对'
                      : '错'
                    : isCurrent
                      ? '当前'
                      : '未做';
                return (
                  <li key={e.task.taskId}>
                    <button
                      type="button"
                      disabled={e.canceled}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm',
                        isCurrent ? 'bg-accent-soft' : 'hover:bg-muted',
                        e.canceled && 'opacity-50',
                      )}
                      onClick={() => {
                        onJump(isCurrent ? null : i);
                        setOpen(false);
                      }}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className={cn('text-foreground', isCurrent && 'font-medium text-accent')}>
                          {e.task.item.target}
                        </span>
                        <span className="text-xs text-muted-foreground/60">
                          {TYPE_LABEL[e.task.taskType]}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'flex items-center gap-1 text-xs',
                          e.result?.correct
                            ? 'text-success'
                            : e.result
                              ? 'text-destructive'
                              : 'text-muted-foreground',
                        )}
                      >
                        {e.result ? (
                          e.result.correct ? (
                            <Check className="h-3 w-3" aria-hidden />
                          ) : (
                            <X className="h-3 w-3" aria-hidden />
                          )
                        ) : null}
                        {status}
                      </span>
                    </button>
                  </li>
                );
              }) ?? null}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

interface ActiveSessionProps {
  progress: TodayProgress | null;
  currentTask: TodayTaskView | null;
  frozen: FrozenAnswer | null;
  onAnswered: (frozen: FrozenAnswer) => void;
  onAdvance: () => void;
}

export function ActiveSession({
  progress,
  currentTask,
  frozen,
  onAnswered,
  onAdvance,
}: ActiveSessionProps) {
  const [hold, setHold] = useState(false);
  const later = useLater();
  const { data: sessionTasks } = useSessionTasks();
  const entries = sessionTasks?.tasks ?? null;
  /** null = 当前题；数字 = 回看/跳做条目索引 */
  const [cursor, setCursor] = useState<number | null>(null);

  const handleHoldChange = useCallback((next: boolean) => setHold(next), []);

  // 当前题在会话序列中的索引（以 currentTask/frozen 的 taskId 定位；兜底第一个未完成）
  const currentIdx = useMemo(() => {
    if (!entries || entries.length === 0) return null;
    const id = currentTask?.taskId ?? frozen?.task.taskId ?? null;
    let idx = id !== null ? entries.findIndex((e) => e.task.taskId === id) : -1;
    if (idx === -1) {
      idx = entries.findIndex((e) => !e.canceled && e.result === null);
      if (idx === -1) idx = entries.length - 1;
    }
    return idx;
  }, [entries, currentTask, frozen]);

  const handleAnswered = useCallback(
    (task: TodayTaskView, result: AnswerResponse) => {
      setCursor(null); // 确保回到当前
      onAnswered({ task, result });
    },
    [onAnswered],
  );

  // 答对自动下一题（仅当前题、非回看/跳做）
  useEffect(() => {
    if (cursor !== null) return;
    if (!frozen || !frozen.result.correct || MANUAL_ADVANCE_TYPES.has(frozen.task.taskType) || hold)
      return;
    const timer = setTimeout(onAdvance, CORRECT_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [frozen, hold, onAdvance, cursor]);

  const shownIdx = cursor ?? currentIdx;
  const entry = entries && shownIdx !== null && shownIdx < entries.length ? entries[shownIdx]! : null;
  const isCurrent = cursor === null;
  const shownTask = entry ? entry.task : (frozen?.task ?? currentTask);
  const shownResult = isCurrent ? (frozen?.result ?? null) : (entry?.result ?? null);
  // 跳做未完成任务 = 可作答；回看已完成 = 只读
  const reviewing = !isCurrent && (entry === null || entry.result !== null);

  // 相邻导航（跳过撤销条目）；返回 false = 边界回弹
  const stepCursor = useCallback(
    (dir: -1 | 1): boolean => {
      if (!entries || entries.length === 0) return false;
      const from = cursor ?? currentIdx;
      if (from === null) return false;
      let i = from + dir;
      while (i >= 0 && i < entries.length && entries[i]!.canceled) i += dir;
      if (i < 0 || i >= entries.length) return false;
      setCursor(i === currentIdx ? null : i);
      return true;
    },
    [entries, cursor, currentIdx],
  );

  const handleSwipeLeft = useCallback((): boolean => stepCursor(-1), [stepCursor]);

  const handleSwipeRight = useCallback((): boolean => {
    if (cursor !== null) return stepCursor(1);
    // 当前题：已答 → 下一题；未答 → 稍后再做（推到队尾）
    if (frozen?.result) {
      onAdvance();
      return true;
    }
    if (currentTask) {
      later.mutate(currentTask.taskId);
      return true;
    }
    return false;
  }, [cursor, stepCursor, frozen, currentTask, later, onAdvance]);

  // 键盘 ←/→ 与滑动同语义（输入框聚焦时忽略）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowLeft') handleSwipeLeft();
      if (e.key === 'ArrowRight') handleSwipeRight();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSwipeLeft, handleSwipeRight]);

  return (
    <div className="space-y-4">
      {reviewing ? (
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground"
          onClick={() => setCursor(null)}
        >
          <ChevronLeft className="h-3 w-3" aria-hidden />
          返回当前
        </button>
      ) : null}

      <ProgressRow
        progress={progress}
        entries={entries}
        currentIdx={currentIdx}
        shownIdx={shownIdx}
        onJump={(i) => setCursor(i)}
      />

      <SwipeDeck onSwipeLeft={handleSwipeLeft} onSwipeRight={handleSwipeRight}>
        {shownTask ? (
          <TaskCard
            key={shownTask.taskId}
            task={shownTask}
            result={shownResult}
            readOnly={reviewing}
            onAnswered={reviewing ? undefined : (result) => handleAnswered(shownTask, result)}
            onAdvance={reviewing ? undefined : onAdvance}
            onHoldChange={reviewing ? undefined : handleHoldChange}
          />
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">正在加载下一题…</p>
        )}
      </SwipeDeck>
    </div>
  );
}
```

要点（与旧行为对照）：
- 删除了本地 `history` 数组、`answeredTaskIds` ref、旧 touch handlers（由 SwipeDeck 接管）。
- 旧测试若断言旧 DOM（如"后续任务完成前不可跳转"文案）需同步更新——跑全量 web 测试后逐个修。

- [ ] **Step 6: 运行新测试确认通过**

```bash
pnpm --dir apps/web exec vitest run tests/today-navigation.test.tsx
```

Expected: 7 个用例全 PASS。

- [ ] **Step 7: 全量 web 回归**

```bash
pnpm --dir apps/web exec vitest run
```

Expected: 全部 PASS。重点关注 today-active/today-choice/today-cloze/today-production——stubApi 的默认批量桩让它们无需修改即可通过；若个别失败按新 DOM 契约更新断言。

- [ ] **Step 8: typecheck**

```bash
pnpm typecheck
```

Expected: 通过。

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/today/api.ts apps/web/src/features/today/components/ActiveSession.tsx apps/web/tests/today-helpers.tsx apps/web/tests/today-navigation.test.tsx
git -c user.name="虎嗅蔷薇" -c user.email="timxinyao@gmail.com" commit -m "feat(web): Today 会话导航改版——sessionTasks 主轴、位置进度着色、全量列表跳做、键盘导航

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 7: E2E 导航用例

**Files:**
- Modify: `apps/web/e2e/today.spec.ts`（追加 1 个 test）

**Interfaces:**
- Consumes: Task 6 的 DOM 契约（列表弹层、第 X / N、返回当前按钮）。
- Produces: 无

- [ ] **Step 1: 在 today.spec.ts 的 `test.describe('Today 复习全流程', ...)` 内追加用例**

```ts
  test('导航：列表回看与跳做未完成任务', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();

    // Learn 卡（gravity，序列第 1 题）答对进入下一题
    await expect(page.getByText('I laugh at gravity all the time.')).toBeVisible();
    await page.getByRole('button', { name: '重力' }).click();
    await continueAfterCorrect(page);

    // 打开列表：全量任务；点已完成的 gravity 回看
    await page.getByRole('button', { name: '查看任务列表' }).click();
    const dialog = page.getByRole('dialog', { name: '任务列表' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('gravity')).toBeVisible();
    await dialog.getByRole('button', { name: /gravity/ }).click();
    await expect(page.getByText(/^第 1 \/ \d+$/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'gravity' })).toBeVisible();
    await page.getByRole('button', { name: '返回当前' }).click();

    // 跳做一个未完成任务（stable）：题面出现且可作答
    await page.getByRole('button', { name: '查看任务列表' }).click();
    await dialog.getByRole('button', { name: /stable/ }).click();
    await expect(page.getByText(/\/ \d+$/)).toBeVisible();
    await expect(page.getByText('"stable" 的意思是？')).toBeVisible();
    await page.getByRole('button', { name: '稳定的' }).click();
    await expect(page.getByText('回答正确')).toBeVisible();
    await continueAfterCorrect(page);
  });
```

（用例假设种子任务顺序 gravity(learn) 在前、stable 待做；若种子顺序不同，以 `/api/__e2e/reset` 后实际首卡为准调整识别条件。）

- [ ] **Step 2: 运行 E2E（只跑 today spec）**

```bash
pnpm --dir apps/web exec playwright test e2e/today.spec.ts
```

Expected: 全部 PASS（含既有用例）。注意：E2E 需要 dev/preview server（playwright config 自起）；跑前确认无其他重任务占用内存。

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/today.spec.ts
git -c user.name="虎嗅蔷薇" -c user.email="timxinyao@gmail.com" commit -m "test(e2e): Today 会话导航——列表回看与跳做未完成任务

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 8: 全量门禁 + phase-7 收尾留档

**Files:**
- Modify: `docs/phases/phase-7-today-navigation.md`（勾选完成标准、状态 done、变更日志）
- Modify: `docs/PHASES.md`（Phase 7 状态改 done）

**Interfaces:**
- Consumes: Task 1-7 全部完成
- Produces: 收尾留档

- [ ] **Step 1: 全量门禁**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: 全部通过。任何失败先修复再继续（禁止跳过）。

- [ ] **Step 2: phase-7 留档收尾**

`docs/phases/phase-7-today-navigation.md`：
- 状态行改为 `done（2026-09-26）`
- 完成标准逐条勾选（`- [x]`）
- 变更日志追加实际交付内容（端点、组件、测试数量）

`docs/PHASES.md` Phase 7 行状态改 `done（2026-09-26）`。

- [ ] **Step 3: Commit**

```bash
git add docs/phases/phase-7-today-navigation.md docs/PHASES.md
git -c user.name="虎嗅蔷薇" -c user.email="timxinyao@gmail.com" commit -m "docs: phase-7 收尾——Today 会话导航改版完成留档

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 9: 部署（需用户确认后执行）

**Files:** 无代码改动（执行 `deploy/deploy.sh`）

**Interfaces:**
- Consumes: Task 8 通过
- Produces: 线上更新

- [ ] **Step 1: 向用户确认部署**（本机 2026-09-26 上午部署曾触发内存耗尽冻结；earlyoom 已装但需谨慎）

- [ ] **Step 2: 受限内存部署**

```bash
free -m   # 确认可用内存 >600M 或 swap 充足
NODE_OPTIONS=--max-old-space-size=1024 ./deploy/deploy.sh
```

- [ ] **Step 3: 验证**

```bash
curl -fsS http://127.0.0.1:8080/api/health
curl -fsSk -o /dev/null -w '%{http_code}\n' https://18-136-183-11.nip.io/
md5sum apps/web/dist/assets/*.js /opt/english-learning/app/apps/web/dist/assets/*.js | sort | uniq -c -w 32
```

Expected: health ok；HTTPS 200；产物 md5 两两成对一致。
