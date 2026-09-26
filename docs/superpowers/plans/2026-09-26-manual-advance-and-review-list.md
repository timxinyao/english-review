# 手动下一题 + 列表只读 + 完成页回顾 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 答对/答对统一手动"下一题"（全删自动跳题链路）；会话列表未做条目不可点（删跳做）；完成页新增只读"今日回顾"列表（错题前置，点击进 Library 详情）。

**Architecture:** 改动集中在 web 前端：共用题卡（ChoiceQuestionCard）、ActiveSession（删 effect/armedRef/hold）、PracticeView（删自动推进）、CompletedToday（新列表）。API 零改动（/api/today/tasks 完成后仍返回当天 session，按 sessionDate 查询）。

**Tech Stack:** React 18 + TS、Tailwind v4、vitest + @testing-library（apps/web/tests/）、Playwright（apps/web/e2e/）、pnpm workspace。

**规格：** `docs/superpowers/specs/2026-09-26-manual-advance-and-review-list-design.md`

## Global Constraints

- 仓库根：`/var/www/english-review`；所有命令在根目录执行。
- 单测：`pnpm --filter @el/web run test`（vitest run，全部通过才算过）。
- e2e：`E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "<片段>"`（生产 API 占 5174；`pnpm run e2e -- -g` 不透传，必须 exec 形式）。
- 服务器仅 1.9G 内存：禁止单测与 e2e 并发跑；构建一律带 `NODE_OPTIONS=--max-old-space-size=768`。
- API 层零改动；`CORRECT_AUTO_ADVANCE_MS` 常量全库删除后不得有残留引用。
- 提交信息末尾加：
  ```
  via [HAPI](https://hapi.run)

  Co-Authored-By: HAPI <noreply@hapi.run>
  ```
- 不要 push、不要部署（编排者统一做）。

---

### Task 1: 答对手动下一题（删除自动跳题全链路）

**Files:**
- Modify: `apps/web/src/components/choice-question-card.tsx`
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx`
- Modify: `apps/web/src/features/today/components/TaskCard.tsx`（删 onHoldChange）
- Modify: `apps/web/src/features/library/PracticeView.tsx`
- Modify: `apps/web/src/lib/questions.ts`（删常量）
- Test: `apps/web/tests/today-navigation.test.tsx`

**Interfaces:**
- Produces: ChoiceQuestionCard 答对态渲染 `下一题` 按钮（无倒计时/无点击任意处）；TaskCard Props 不再有 `onHoldChange`；`questions.ts` 不再导出 `CORRECT_AUTO_ADVANCE_MS`。

- [ ] **Step 1: 改单测（RED）**

`apps/web/tests/today-navigation.test.tsx`：

1a. 删除两个倒计时用例：`it('答对不动 → 4s 自动跳题（基线行为）', ...)` 与 `it('答对后回看返回当前：不再重新武装自动跳题', ...)`（连同步的 `stubAnsweredSession` helper 一并删除；后续 Task 3 不依赖它）。

1b. 同位置新增（RED：现状答对无按钮、且 4s 会自动跳）：

```ts
  it('答对：显示"下一题"按钮，点击推进；不再自动跳题', async () => {
    let answered = false;
    stubApi({
      '/api/today': () =>
        answered ? makeActive(t4, { completed: 3, total: 4 }) : makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': () =>
        answered
          ? makeTasksResponse([
              makeSessionEntry(t1, makeCorrectAnswer()),
              makeSessionEntry(t2, makeWrongAnswer()),
              makeSessionEntry(t3, makeCorrectAnswer()),
              makeSessionEntry(t4, null),
            ])
          : makeTasksResponse([
              makeSessionEntry(t1, makeCorrectAnswer()),
              makeSessionEntry(t2, makeWrongAnswer()),
              makeSessionEntry(t3, null),
              makeSessionEntry(t4, null),
            ]),
      '/api/today/tasks/task-3/answer': () => {
        answered = true;
        return makeCorrectAnswer();
      },
    });
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '稳定的' }));
    await screen.findByText('回答正确');
    // 不自动跳：超过原 4s 窗口仍停留本题反馈
    await new Promise((r) => setTimeout(r, 5000));
    expect(screen.getByText('回答正确')).toBeVisible();
    expect(screen.queryByText('第 4 / 4')).toBeNull();
    // 统一手动下一题按钮
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    await screen.findByText('第 4 / 4');
  }, 15_000);
```

- [ ] **Step 2: 跑单测确认 RED**

Run: `pnpm --filter @el/web run test -- today-navigation`
Expected: 新用例 FAIL（答对态无"下一题"按钮；且 4s 后被自动推进，第 4 / 4 出现违反断言）。

- [ ] **Step 3: 实现**

3a. `apps/web/src/components/choice-question-card.tsx`：
- 删除 `CountdownLabel` 函数组件整段（含其上方注释）；import 区的 `useEffect` 因此不再使用则删除（`useState`/`useMemo` 仍被组件其余逻辑使用，保留）。
- 根节点 `<div className="space-y-4" onClick={...} /* 答对后点击任意处... */>` 改回 `<div className="space-y-4">`（删 onClick 与注释）。
- `sendFeedback` 中 `e.stopPropagation(); // 不触发"点击任意处继续"` 一行删除（参数 `e: MouseEvent` 随之不需要，`onClick={(e) => sendFeedback('guessed', e)}` 改为 `onClick={() => sendFeedback('guessed')}`，两处 wrong 一处 correct 共三处；`sendFeedback(kind: 'guessed' | 'too_easy')`）。
- correct 态块中 `<CountdownLabel />` 替换为与 wrong 态同构的按钮行，整个 correct 块改为：

```tsx
      {phase === 'correct' && (
        <div className="space-y-3">
          <p className="text-sm text-success">回答正确</p>
          <div className="flex items-center justify-between gap-2">
            {onFeedback && (
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted"
                  onClick={() => sendFeedback('guessed')}
                >
                  其实是蒙的
                </button>
                <button
                  type="button"
                  className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted"
                  onClick={() => sendFeedback('too_easy')}
                >
                  太简单了
                </button>
              </div>
            )}
            <Button onClick={onAdvance}>下一题</Button>
          </div>
        </div>
      )}
```

3b. `apps/web/src/features/today/components/ActiveSession.tsx`：
- 删除 `import { CORRECT_AUTO_ADVANCE_MS } from '../../../lib/questions';` 与 `export { CORRECT_AUTO_ADVANCE_MS };`
- 删除 `MANUAL_ADVANCE_TYPES` 常量块。
- 删除 `const [hold, setHold] = useState(false);`、`armedRef` 声明及其两段注释、unmount 重置 effect、`handleHoldChange`、自动跳题 effect（含"不变量"注释整段）。
- TaskCard 调用处删除 `onHoldChange={reviewing ? undefined : handleHoldChange}` 一行。

3c. `apps/web/src/features/today/components/TaskCard.tsx`：
- Props 删除 `onHoldChange?: (hold: boolean) => void;` 及其注释行。
- 函数签名去掉 `onHoldChange`；`closeBadConfirm` 中 `onHoldChange?.(false);` 删除；坏题按钮 onClick 中 `onHoldChange?.(true);` 删除。

3d. `apps/web/src/features/library/PracticeView.tsx`：
- 删除 `import { CORRECT_AUTO_ADVANCE_MS } from '../../lib/questions';`
- 删除自动推进 effect 整段（`// 选择题答对：约 2 秒自动下一题/点击任意处继续（与 Today 一致）；填空/表达手动` 注释 + useEffect）。

3e. `apps/web/src/lib/questions.ts`：删除 `export const CORRECT_AUTO_ADVANCE_MS = 4000;`（若该文件因此为空或仅剩无关内容，保留其余内容，只删此行）。

- [ ] **Step 4: 跑单测确认 GREEN**

Run: `pnpm --filter @el/web run test`
Expected: 全部 PASS（注意 library 相关单测若引用倒计时需同步——先全局 grep `CORRECT_AUTO_ADVANCE_MS|CountdownLabel` 确认零残留）。

- [ ] **Step 5: e2e 同步（continueAfterCorrect 与涉及用例）**

`apps/web/e2e/today.spec.ts` 的 helper 替换为：

```ts
/** 答对/答错后：统一点"下一题"按钮推进（自动跳题已删除） */
async function continueAfterCorrect(page: Page) {
  const feedback = page.getByText('回答正确');
  await expect(feedback).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: '下一题' }).click();
}
```

倒计时用例 `test('倒计时：答对后列表回看返回当前不自动跳题，点反馈进下一题', ...)` 整体删除（语义由单测 1b 覆盖；列表回看返回不推进已无倒计时概念）。

- [ ] **Step 6: 跑 today e2e**

Run: `E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "Today"`
Expected: PASS（主流程与导航用例中所有推进均走"下一题"按钮；若主流程某分支原先依赖点击反馈文本推进，改为该按钮）。

- [ ] **Step 7: typecheck + Commit**

Run: `pnpm --filter @el/web run typecheck` → 无错误。

```bash
git add -A apps/web/src apps/web/tests apps/web/e2e
git commit -m "feat(web): 答对改手动下一题——删除自动跳题/倒计时/hold 全链路（Today 与练习统一）

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 2: 会话列表只读（删除跳做）

**Files:**
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx`（ProgressRow 条目 disabled + reviewing 简化 + 注释）
- Test: `apps/web/tests/today-navigation.test.tsx`
- Test: `apps/web/e2e/today.spec.ts`

**Interfaces:**
- Consumes: Task 1 后的 ActiveSession（无自动跳题）。
- Produces: 列表条目可点条件 = 已完成（result 非空）或"当前"；未做/已撤销 disabled。

- [ ] **Step 1: 改单测（RED）**

`apps/web/tests/today-navigation.test.tsx`：

1a. 用例 `it('列表弹层：显示全部 4 个任务与状态；点未完成任务跳去做并可作答', ...)` 整体替换为：

```ts
  it('列表只读：未做条目置灰不可点；已完成可点回看', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const dialog = screen.getByRole('dialog', { name: '任务列表' });
    await waitFor(() => expect(dialog).toBeVisible());

    // 未做（delta，非当前）置灰不可点：点击不跳转、弹层不关闭
    const deltaBtn = within(dialog).getByRole('button', { name: /delta/ });
    expect(deltaBtn).toBeDisabled();
    fireEvent.click(deltaBtn);
    expect(screen.queryByRole('dialog', { name: '任务列表' })).toBeVisible();

    // 已完成（alpha）可点回看
    fireEvent.click(within(dialog).getByRole('button', { name: /alpha/ }));
    await screen.findByText('第 1 / 4');
    expect(screen.getByRole('heading', { name: 'alpha' })).toBeVisible();
  });
```

1b. 若既有用例 `it('列表点"当前"项 → 回到当前题 第 3 / 4', ...)` 或"键盘"用例依赖先跳 delta 再返回的路径——检查并确保它们只使用已完成条目导航（现状已满足，无需改）。

- [ ] **Step 2: 跑单测确认 RED**

Run: `pnpm --filter @el/web run test -- today-navigation`
Expected: 新用例 FAIL（现状 delta 未做条目可点且跳做成功）。

- [ ] **Step 3: 实现**

`apps/web/src/features/today/components/ActiveSession.tsx` ProgressRow 内条目按钮：

```tsx
                      <button
                        type="button"
                        disabled={e.canceled || (!e.result && !isCurrent)}
```

（其余样式与逻辑不变；`disabled` 时既有 `e.canceled && 'opacity-50'` 样式扩展为 `disabled && 'opacity-50'`：`cn(..., isCurrent ? 'bg-accent-soft' : 'hover:bg-muted', disabled && 'opacity-50')`——需在 map 内先取 `const disabled = e.canceled || (!e.result && !isCurrent);`。）

同文件 reviewing 语义简化：

```tsx
  // 回看（列表只点已完成条目或"当前"）：cursor 只指向已完成条目
  const reviewing = cursor !== null;
```

（删除原 `const reviewing = !isCurrent && (entry === null || entry.result !== null);` 与其注释。）

- [ ] **Step 4: 跑单测确认 GREEN**

Run: `pnpm --filter @el/web run test`
Expected: 全部 PASS。

- [ ] **Step 5: e2e 同步**

`apps/web/e2e/today.spec.ts` 用例 `test('导航：列表回看与跳做未完成任务', ...)`：
- 标题改为 `导航：列表回看与未做条目置灰`
- "跳做一个未完成任务（stable…）"整段（打开列表点 stable、答 稳定的、continueAfterCorrect）替换为：

```ts
    // 未做条目（stable，非当前）置灰不可点
    await page.getByRole('button', { name: '查看任务列表' }).click();
    const stableEntry = dialog.getByRole('button', { name: /stable/ });
    await expect(stableEntry).toBeDisabled();
    await stableEntry.click({ force: true });
    await expect(page.getByText(/^第 1 \/ \d+$/)).toBeVisible(); // 仍停留回看位
```

- [ ] **Step 6: 跑 today e2e + Commit**

Run: `E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "导航"`
Expected: PASS。

```bash
git add apps/web/src/features/today/components/ActiveSession.tsx apps/web/tests/today-navigation.test.tsx apps/web/e2e/today.spec.ts
git commit -m "feat(web): 会话列表降级只读——未做条目置灰不可点，删除跳做

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 3: 完成页"今日回顾"列表

**Files:**
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx`（导出 TYPE_LABEL）
- Modify: `apps/web/src/features/today/components/CompletedToday.tsx`
- Test: `apps/web/tests/completed-today.test.tsx`（新建）
- Test: `apps/web/e2e/today.spec.ts`（主流程末尾断言）

**Interfaces:**
- Consumes: `useSessionTasks()`（GET /api/today/tasks，完成后仍返回当天 session）；`SessionTaskEntry`；路由 `/library/:itemId`。
- Produces: `export const TYPE_LABEL`（ActiveSession）供 CompletedToday 复用。

- [ ] **Step 1: 写失败单测（新文件 completed-today.test.tsx）**

```tsx
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiCalls,
  makeCanceledEntry,
  makeChoiceTask,
  makeCorrectAnswer,
  makeSessionEntry,
  makeTasksResponse,
  makeWrongAnswer,
  renderTodayApp,
  stubApi,
} from './today-helpers';
import type { SessionTaskEntry } from '@el/shared';

afterEach(cleanup);

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));

const t1 = makeChoiceTask({ taskId: 'task-1', item: { id: 'i1', type: 'word', target: 'alpha', meaning: '甲', ipa: null } });
const t2 = makeChoiceTask({ taskId: 'task-2', item: { id: 'i2', type: 'word', target: 'beta', meaning: '乙', ipa: null } });
const t3 = makeChoiceTask({ taskId: 'task-3', item: { id: 'i3', type: 'word', target: 'gamma', meaning: '丙', ipa: null } });

describe('完成页今日回顾', () => {
  it('答错在前、答对次之、已撤销最后；点击跳 Library 详情', async () => {
    stubApi({
      '/api/today': {
        status: 'completed',
        summary: {
          totalTasks: 3,
          pass: 1,
          basicPass: 0,
          fail: 1,
          newItemsStarted: 0,
          recommendRead: false,
        },
      },
      '/api/today/tasks': makeTasksResponse([
        makeSessionEntry(t1, makeCorrectAnswer()),
        makeSessionEntry(t2, makeWrongAnswer()),
        makeCanceledEntry(t3),
      ]),
    });
    renderTodayApp();
    await screen.findByText('今天完成了');

    const list = screen.getByRole('list', { name: '今日回顾' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('beta')).toBeVisible(); // 答错在前
    expect(within(rows[1]!).getByText('alpha')).toBeVisible();
    expect(within(rows[2]!).getByText('已撤销')).toBeVisible();

    // 点击跳 Library 详情
    fireEvent.click(within(rows[0]!).getByRole('link', { name: /beta/ }));
    expect(screen.queryByRole('list', { name: '今日回顾' })).toBeVisible();
  });
});
```

注：若 `today-helpers.tsx` 尚无 `makeCanceledEntry`，在该文件补：

```tsx
/** 已撤销条目（result 不回放） */
export function makeCanceledEntry(task: TodayTaskView): SessionTaskEntry {
  return makeSessionEntry(task, null, true);
}
```

（链接断言用 MemoryRouter 内 click 不导航报错即可；如需验证目标路由，`within(rows[0]!).getByRole('link')` 加 `expect(link).toHaveAttribute('href', '/library/i2')`。）

- [ ] **Step 2: 跑单测确认 RED**

Run: `pnpm --filter @el/web run test -- completed-today`
Expected: FAIL（无"今日回顾"列表）。

- [ ] **Step 3: 实现**

3a. `ActiveSession.tsx`：`const TYPE_LABEL: Record<...>` 改为 `export const TYPE_LABEL: Record<...>`。

3b. `CompletedToday.tsx` 整文件替换为：

```tsx
import type { SessionTaskEntry, TodayCompletedResponse } from '@el/shared';
import { Check, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../../../lib/utils';
import { useSessionTasks } from '../api';
import { TYPE_LABEL } from './ActiveSession';

/** 排序权重：答错 0 < 答对 1 < 已撤销 2 */
function reviewWeight(e: SessionTaskEntry): number {
  if (e.canceled) return 2;
  return e.result && !e.result.correct ? 0 : 1;
}

/** completed 态：安静完成摘要（PRODUCT §4.3/§5.1）+ 今日回顾列表（错题前置，点击进 Library 可练） */
export function CompletedToday({ data }: { data: TodayCompletedResponse }) {
  const { summary } = data;
  const { data: sessionTasks } = useSessionTasks();
  const entries = [...(sessionTasks?.tasks ?? [])].sort((a, b) => reviewWeight(a) - reviewWeight(b));

  return (
    <div className="space-y-4 py-12">
      <div className="space-y-3 text-center">
        <h2 className="text-xl font-semibold text-foreground">今天完成了</h2>
        <p className="text-sm text-muted-foreground">
          共完成 {summary.totalTasks} 个任务 · 新学 {summary.newItemsStarted} 项
        </p>
        <p className="text-sm text-muted-foreground">
          通过 {summary.pass} · 基础通过 {summary.basicPass} · 未通过 {summary.fail}
        </p>
        {summary.recommendRead && (
          <p className="text-sm text-muted-foreground">
            <Link to="/read" className="text-accent underline-offset-2 hover:underline">
              生成一篇 Read 复现今日内容
            </Link>
          </p>
        )}
      </div>

      {entries.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-medium text-foreground">今日回顾</h3>
          <ul aria-label="今日回顾" className="space-y-1">
            {entries.map((e) => {
              const status = e.canceled
                ? '已撤销'
                : e.result
                  ? e.result.correct
                    ? '对'
                    : '错'
                  : '未做';
              return (
                <li key={e.task.taskId}>
                  <Link
                    to={`/library/${e.task.item.id}`}
                    className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-muted"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="text-foreground">{e.task.item.target}</span>
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
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑单测确认 GREEN**

Run: `pnpm --filter @el/web run test`
Expected: 全部 PASS。

- [ ] **Step 5: e2e 主流程末尾断言**

`apps/web/e2e/today.spec.ts` 主流程用例在完成摘要断言后追加：

```ts
    // 今日回顾列表：错题在前，含答错的 stable
    const reviewList = page.getByRole('list', { name: '今日回顾' });
    await expect(reviewList).toBeVisible();
    const firstRow = reviewList.getByRole('listitem').first();
    await expect(firstRow).toContainText('错');
```

- [ ] **Step 6: 跑 today e2e + typecheck + Commit**

Run: `E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "Today"` → PASS。
Run: `pnpm --filter @el/web run typecheck` → 无错误。

```bash
git add apps/web/src/features/today/components/ActiveSession.tsx apps/web/src/features/today/components/CompletedToday.tsx apps/web/tests/completed-today.test.tsx apps/web/tests/today-helpers.tsx apps/web/e2e/today.spec.ts
git commit -m "feat(web): 完成页今日回顾——错题前置只读列表，点击进 Library 练习

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 4: 全量验证

**Files:** 无新改动（验证型任务）。

- [ ] **Step 1:** Run: `pnpm --filter @el/web run typecheck` → 无错误。
- [ ] **Step 2:** Run: `pnpm --filter @el/web run test` → 全部 PASS。
- [ ] **Step 3:** Run: `E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test` → 全部 PASS。
- [ ] **Step 4:** Run: `NODE_OPTIONS=--max-old-space-size=768 pnpm --filter @el/web run build` → `✓ built in` 成功。

（无提交；部署与推送由编排者统一执行。）
