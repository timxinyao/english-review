# 移除滑动导航 + 弹层 Portal 层叠 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today 会话删除全部滑动/键盘导航（列表为唯一导航入口），弹层改 portal + z-index 令牌全局分层，防菜单遮挡再犯。

**Architecture:** ActiveSession 回归普通 div 布局并删除 SwipeDeck/键盘/later UI 触发（armedRef 倒计时语义不变）；globals.css 以 Tailwind v4 `@theme inline` 定义 z 令牌，shell 与任务列表弹层改用令牌，弹层 createPortal 到 body。

**Tech Stack:** React 18 + TS、Tailwind v4（@tailwindcss/vite，CSS @theme 配置）、vitest + @testing-library（apps/web/tests/）、Playwright（apps/web/e2e/）、pnpm workspace。

**规格：** `docs/superpowers/specs/2026-09-26-remove-swipe-nav-and-portal-overlay-design.md`

## Global Constraints

- 仓库根：`/var/www/english-review`；所有命令在根目录执行。
- 单测：`pnpm --filter @el/web run test`（vitest run，全部通过才算过）。
- e2e：`E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "<片段>"`（生产 API 占 5174；注意 `pnpm run e2e -- -g` 不透传，必须 exec 形式）。
- 服务器仅 1.9G 内存：禁止单测与 e2e 并发跑；构建一律带 `NODE_OPTIONS=--max-old-space-size=768`。
- `CORRECT_AUTO_ADVANCE_MS = 4000` 不改；armedRef 单次武装语义与 unmount 重置 effect 不动。
- 提交信息末尾加：
  ```
  via [HAPI](https://hapi.run)

  Co-Authored-By: HAPI <noreply@hapi.run>
  ```
- 不要 push、不要部署（编排者统一做）。

---

### Task 1: 删除滑动导航（ActiveSession + SwipeDeck 移除）

**Files:**
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx`
- Delete: `apps/web/src/features/today/components/SwipeDeck.tsx`
- Delete: `apps/web/tests/swipe-deck.test.tsx`
- Test: `apps/web/tests/today-navigation.test.tsx`（改写）

**Interfaces:**
- Consumes: 既有 ProgressRow `onJump`（列表导航）、TaskCard 反馈区点击=onAdvance。
- Produces: ActiveSession 根容器为普通 `div.space-y-4`（无 SwipeDeck/data-swipe-*）；`useLater` 不再被组件引用（`../api` 导出保留）。

- [ ] **Step 1: 改写 today-navigation.test.tsx（RED 两处新断言）**

对 `apps/web/tests/today-navigation.test.tsx` 做以下修改（其余用例不动）：

1a. 删除 `swipeBy` helper（第 37-43 行附近整段）。

1b. 删除以下用例（滑动语义随功能删除）：
- `it('左滑回看：数字变 第 2 / 4，卡片只读且显示单词行', ...)`（其列表路径覆盖由既有"列表弹层"与新增 1e 覆盖）
- `it('当前题未作答右滑 → 稍后再做（later 调用，回归）', ...)`
- `it('回看到最前后继续左滑 → 停留 第 1 / 4（边界回弹）', ...)`
- `it('跳到最后一条后右滑越过末尾 → 回到当前题 第 3 / 4', ...)`
- `it('左滑回看跳过已撤销条目 → 落在 第 1 / 4', ...)`

1c. 把 `it('键盘 ← 回看、→ 返回当前', ...)` 整体替换为（RED：现行代码键盘会导航）：

```ts
  it('键盘 ←/→ 不再导航（滑动导航已删除）', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByText('第 3 / 4')).toBeVisible());
    expect(apiCalls('/api/today/tasks/task-3/later')).toHaveLength(0);
  });
```

1d. 新增 later 无 UI 入口断言（RED：现行 ArrowRight 会触发 later——与 1c 合并覆盖）：

```ts
  it('无稍后再做入口：任何键盘操作不产生 later 调用', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await new Promise((r) => setTimeout(r, 200));
    expect(apiCalls('/api/today/tasks/task-3/later')).toHaveLength(0);
  });
```

1e. 新增列表点当前项回当前（覆盖原"右滑越末回当前"路径）：

```ts
  it('列表点"当前"项 → 回到当前题 第 3 / 4', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const withinDialog = within(screen.getByRole('dialog', { name: '任务列表' }));
    fireEvent.click(withinDialog.getByRole('button', { name: /beta/ }));
    await screen.findByText('第 2 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /gamma/ }));
    await screen.findByText('第 3 / 4');
  });
```

1f. 两个倒计时用例中的滑动改为列表导航（行为保持，非 RED）：
- `it('答对后回看返回当前：不再重新武装自动跳题', ...)` 中 `swipeBy(-120); await screen.findByText('第 2 / 4');` 替换为：

```ts
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /beta/ }));
    await screen.findByText('第 2 / 4');
```

  其中 `swipeBy(120); await screen.findByText('第 3 / 4');` 替换为：

```ts
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /gamma/ }));
    await screen.findByText('第 3 / 4');
```

  末尾手动推进 `swipeBy(120); await screen.findByRole('heading', { name: 'delta' }, ...)` 替换为（点击反馈区=onAdvance）：

```ts
    fireEvent.click(screen.getByText('回答正确'));
    await screen.findByText('第 4 / 4');
```

  （注意：该用例断言用的是进度文本 `第 4 / 4`，沿用现状；`gamma` 断言不动。）
- `it('答对不动 → 4s 自动跳题（基线行为）', ...)` 无滑动，不动。

1g. 删除文件 `apps/web/tests/swipe-deck.test.tsx` 与 `apps/web/src/features/today/components/SwipeDeck.tsx`：

```bash
git rm apps/web/tests/swipe-deck.test.tsx apps/web/src/features/today/components/SwipeDeck.tsx
```

- [ ] **Step 2: 跑单测确认 RED**

Run: `pnpm --filter @el/web run test`
Expected: 1d FAIL（现行 ArrowRight 在未答当前题触发 later，断言 0 次失败——本任务的 RED 信号）；1c 为行为覆盖（旧代码下 ArrowLeft→回看→ArrowRight→回当前恰好也停留第 3/4，可能通过，无妨）；其余 PASS。

- [ ] **Step 3: 修改 ActiveSession.tsx**

3a. import 区（文件头部）改为：

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnswerResponse, SessionTaskEntry, TodayProgress, TodayTaskView } from '@el/shared';
import { Check, X } from 'lucide-react';
import { CORRECT_AUTO_ADVANCE_MS } from '../../../lib/questions';
import { cn } from '../../../lib/utils';
import { TaskCard } from './TaskCard';
import { useSessionTasks } from '../api';
```

（删除 `import { SwipeDeck } from './SwipeDeck';`，`../api` 只留 `useSessionTasks`。）

3b. 删除 `const later = useLater();` 一行。

3c. 删除以下整块（约 247-292 行）：`stepCursor` useCallback、`handleSwipeLeft`、`handleSwipeRight`、键盘 `useEffect`。

3d. return 整体替换为：

```tsx
  return (
    <div className="space-y-4">
      <ProgressRow
        progress={progress}
        entries={entries}
        currentIdx={currentIdx}
        shownIdx={shownIdx}
        onJump={(i) => setCursor(i)}
      />

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
    </div>
  );
```

（armedRef、unmount 重置 effect、自动跳题 effect、`reviewing`、ProgressRow/TaskCard 全部保留原样。）

- [ ] **Step 4: 跑单测确认 GREEN**

Run: `pnpm --filter @el/web run test`
Expected: 全部 PASS。

- [ ] **Step 5: typecheck + Commit**

Run: `pnpm --filter @el/web run typecheck` → 无错误。

```bash
git add -A apps/web/src/features/today apps/web/tests
git commit -m "refactor(web): 删除滑动/键盘导航——列表为 Today 会话唯一导航入口

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 2: z-index 令牌 + 弹层 Portal

**Files:**
- Modify: `apps/web/src/styles/globals.css`（@theme 加 z 令牌）
- Modify: `apps/web/src/app/shell.tsx:89,124`（z-20/z-10 → 令牌）
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx`（ProgressRow 弹层 portal）
- Modify: `docs/DEVELOPMENT.md`（层叠规则留档）
- Test: `apps/web/tests/today-navigation.test.tsx`（新增 portal 断言）

**Interfaces:**
- Produces: Tailwind 令牌类 `z-nav`(10)、`z-header`(20)、`z-overlay`(40)、`z-toast`(50)；DEVELOPMENT.md 规则"新增弹层一律 createPortal(document.body) + z 令牌"。

- [ ] **Step 1: 写失败单测（today-navigation.test.tsx describe 末尾新增）**

```ts
  it('任务列表弹层 portal 到 body：脱离业务容器层叠上下文；点遮罩可关闭', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    const dialog = screen.getByRole('dialog', { name: '任务列表' });
    await waitFor(() => expect(dialog).toBeVisible());
    // portal：弹层直接挂在 body 下，而非 ProgressRow 容器内
    expect(dialog.parentElement).toBe(document.body);
    // 遮罩点击关闭（portal 后 React 合成事件仍沿组件树冒泡，stopPropagation 有效）
    fireEvent.click(dialog.parentElement!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '任务列表' })).toBeNull());
  });
```

- [ ] **Step 2: 跑单测确认 RED**

Run: `pnpm --filter @el/web run test -- today-navigation`
Expected: 新用例 FAIL（`dialog.parentElement` 是 ProgressRow 内 div，非 body）。

- [ ] **Step 3: 实现**

3a. `apps/web/src/styles/globals.css` 的 `@theme inline` 块内追加（与既有 `--color-*` 并列）：

```css
  /* 层叠令牌：nav < header < overlay < toast；弹层一律 portal 到 body 后使用 */
  --z-index-nav: 10;
  --z-index-header: 20;
  --z-index-overlay: 40;
  --z-index-toast: 50;
```

3b. `apps/web/src/app/shell.tsx` 第 89 行 `z-20` → `z-header`；第 124 行 `z-10` → `z-nav`。

3c. `apps/web/src/features/today/components/ActiveSession.tsx`：
- import 区补：`import { createPortal } from 'react-dom';`
- ProgressRow 内 `{open && (...)}` 的弹层 JSX（`<div role="dialog" ...>` 最外层）整块改为：

```tsx
      {open &&
        createPortal(
          <div
            role="dialog"
            aria-label="任务列表"
            className="fixed inset-0 z-overlay flex items-end justify-center bg-foreground/20"
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
          </div>,
          document.body,
        )}
```

（实施时把现版弹层内部内容原样移入，唯一字符串改动是 `z-40` → `z-overlay`。）

- [ ] **Step 4: 跑单测确认 GREEN**

Run: `pnpm --filter @el/web run test`
Expected: 全部 PASS。

- [ ] **Step 5: DEVELOPMENT.md 留档**

`docs/DEVELOPMENT.md` 追加小节：

```markdown
## 层叠与弹层规则（z-index 令牌）

- 令牌定义在 `apps/web/src/styles/globals.css` 的 `@theme inline`：`z-nav`(10) < `z-header`(20) < `z-overlay`(40) < `z-toast`(50)。
- 业务容器禁止裸写 z-index。chrome（底部导航/顶栏）与弹层只用令牌类。
- 新增任何弹层/浮层一律 `createPortal(... , document.body)` 渲染——脱离业务祖先的层叠上下文（perspective/transform 等会困住 z-index），再配 `z-overlay`/`z-toast`。
- 卡片内部局部层叠（如角标）不受此规则约束。
```

- [ ] **Step 6: typecheck + Commit**

Run: `pnpm --filter @el/web run typecheck` → 无错误。

```bash
git add apps/web/src/styles/globals.css apps/web/src/app/shell.tsx apps/web/src/features/today/components/ActiveSession.tsx docs/DEVELOPMENT.md apps/web/tests/today-navigation.test.tsx
git commit -m "feat(web): 弹层 portal 化与 z-index 令牌——全局防菜单遮挡

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 3: e2e 改写（删手势用例、倒计时改列表导航）

**Files:**
- Modify: `apps/web/e2e/today.spec.ts`

**Interfaces:**
- Consumes: Task 1 后无 `[data-swipe-card]`/无 touchSwipe 可用；列表导航既有 locator（`查看任务列表`、`dialog.getByRole('button', { name: /词/ })`）。

- [ ] **Step 1: 改写 e2e**

对 `apps/web/e2e/today.spec.ts`：

1a. 删除 `touchSwipe` helper（整段）与用例 `test('手势：卡片外区域起滑可翻页；按钮起滑不翻页', ...)`（整段）。

1b. 主流程用例 `test('idle → 开始 → Learn + 选择/填空/稍后/答错 → 完成摘要')` 中 wear down 稍后分支（`await page.keyboard.press('ArrowRight'); ...` 段）替换为直接答对（稍后再做已无 UI 入口，later API 场景退出 e2e 覆盖）：

```ts
      // 4) wear down：直接答对（导航简化后无"稍后再做"入口）
      if (await page.getByRole('button', { name: '逐渐消耗' }).isVisible()) {
        await page.getByRole('button', { name: '逐渐消耗' }).click();
        await continueAfterCorrect(page);
        continue;
      }
```

（删除 `wearDownDeferred` 变量声明与赋值。）

1c. 用例 `test('倒计时：答对后回看返回当前不自动跳题，手动右滑进下一题')` 整体替换为：

```ts
  test('倒计时：答对后列表回看返回当前不自动跳题，点反馈进下一题', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();

    // 首卡 give up 表达题（手动推进型）通过 → 手动下一题到 make sense（第 2/6）
    await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();
    await page.getByLabel('表达答案').fill('The constant stress makes me want to give up.');
    await page.getByRole('button', { name: '提交' }).click();
    await expect(page.getByText('通过', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一题' }).click();
    await expect(page.getByText(/^第 2 \/ \d+$/)).toBeVisible();

    // make sense 答对（自动推进型）→ 立即列表回看 give up
    await page.getByRole('button', { name: '讲得通' }).click();
    await expect(page.getByText('回答正确')).toBeVisible();
    await page.getByRole('button', { name: '查看任务列表' }).click();
    const dialog = page.getByRole('dialog', { name: '任务列表' });
    await dialog.getByRole('button', { name: /give up/ }).click();
    await expect(page.getByText(/^第 1 \/ \d+$/)).toBeVisible();

    // 列表点"当前"项回当前（make sense 反馈仍冻结显示）
    await page.getByRole('button', { name: '查看任务列表' }).click();
    await dialog.getByRole('button', { name: /make sense/ }).click();
    await expect(page.getByText(/^第 2 \/ \d+$/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();

    // 超过 4s 自动跳题窗口：不得推进（旧代码会跳到 raw 填空）
    await page.waitForTimeout(5000);
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();

    // 点反馈区手动进入下一题 raw 填空
    await page.getByText('回答正确').click();
    await expect(page.getByLabel('填空答案')).toBeVisible();
  });
```

- [ ] **Step 2: 跑 today e2e**

Run: `E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "Today"`
Expected: 5 passed（主流程 / 导航 / 倒计时 / CompletedToday 等全过）。

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/today.spec.ts
git commit -m "test(e2e): 滑动导航删除后的用例改写——列表导航与点反馈推进

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
