# 手势页面级 + 倒计时单次武装 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today 会话左/右滑手势从卡片升级为页面级；删除"返回当前"按钮；答对自动跳题只在作答瞬间武装一次。

**Architecture:** SwipeDeck 由"卡片容器"重构为"会话区块手势容器"（`data-swipe-area`），跟手 3D 位移只作用于内部 `[data-swipe-card]` 目标；ActiveSession 以 SwipeDeck 作为根容器组合进度行与卡片，并用 `armedRef` 按 frozen 对象身份实现倒计时单次武装。

**Tech Stack:** React 18 + TS、vitest + @testing-library（`apps/web/tests/`）、Playwright（`apps/web/e2e/`）、pnpm workspace。

**规格：** `docs/superpowers/specs/2026-09-26-swipe-pagelevel-and-countdown-design.md`

## Global Constraints

- 仓库根：`/var/www/english-review`；所有命令在根目录执行。
- 单测：`pnpm --filter @el/web run test`（vitest run，全部通过才算过）。
- 单个 e2e：`E2E_API_PORT=5175 pnpm --filter @el/web run e2e -- -g "<名称片段>"`；全量 e2e：`E2E_API_PORT=5175 pnpm --filter @el/web run e2e`（生产 API 占 5174，必须换端口）。
- 服务器仅 1.9G 内存：**禁止**单测与 e2e 并发跑；跑 e2e 前确认无其他构建进行；构建一律带 `NODE_OPTIONS=--max-old-space-size=768`。
- `CORRECT_AUTO_ADVANCE_MS = 4000`（`apps/web/src/lib/questions.ts`），不要改值。
- 提交信息末尾加：
  ```
  via [HAPI](https://hapi.run)

  Co-Authored-By: HAPI <noreply@hapi.run>
  ```
- 不要 push、不要部署（编排者统一做）。
- 手势判定参数不变：阈值 60px、|dx| > |dy|×1.5、`prefers-reduced-motion` 跳过动画。

---

### Task 1: SwipeDeck 页面级重构 + ActiveSession 组合

**Files:**
- Modify: `apps/web/src/features/today/components/SwipeDeck.tsx`（整文件重写）
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx:284-322`（render 部分）
- Test: `apps/web/tests/swipe-deck.test.tsx`（改选择器 + 新增 2 用例）
- Test: `apps/web/tests/today-navigation.test.tsx:37-43`（swipeBy 选择器）
- Test: `apps/web/e2e/today.spec.ts`（新增页面级手势用例 + touchSwipe helper）

**Interfaces:**
- Produces: `SwipeDeck` props `{ onSwipeLeft: () => boolean | void; onSwipeRight: () => boolean | void; className?: string; children: ReactNode }`；根容器属性 `data-swipe-area`；位移目标由 children 内 `[data-swipe-card]` 元素承担（ActiveSession 负责渲染该包裹 div）。

- [ ] **Step 1: 写失败单测（swipe-deck.test.tsx）**

整文件替换为：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SwipeDeck } from '../src/features/today/components/SwipeDeck';

afterEach(cleanup);

/** 手势区块（页面级容器） */
function area(): HTMLElement {
  const el = document.querySelector('[data-swipe-area]');
  if (!(el instanceof HTMLElement)) throw new Error('area 未渲染');
  return el;
}

/** 位移目标卡片 */
function card(): HTMLElement {
  const el = document.querySelector('[data-swipe-card]');
  if (!(el instanceof HTMLElement)) throw new Error('card 未渲染');
  return el;
}

function renderDeck(left: () => boolean | void = vi.fn(), right: () => boolean | void = vi.fn()) {
  render(
    <SwipeDeck onSwipeLeft={left} onSwipeRight={right}>
      <p>进度行</p>
      <button type="button">按钮</button>
      <div data-swipe-card>
        <p>卡片内容</p>
      </div>
    </SwipeDeck>,
  );
}

function swipeBy(dx: number, dy = 0): void {
  const el = area();
  fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 300 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 200 + dx / 2, clientY: 300 + dy }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
}

describe('SwipeDeck（页面级手势）', () => {
  it('渲染 children；卡片外文本（进度行）也在手势区内', () => {
    renderDeck();
    expect(area().textContent).toContain('进度行');
    expect(card().textContent).toContain('卡片内容');
  });

  it('区块任意位置左滑超过阈值 → onSwipeLeft 调用一次', () => {
    const left = vi.fn();
    renderDeck(left);
    swipeBy(-120);
    expect(left).toHaveBeenCalledTimes(1);
  });

  it('右滑超过阈值 → onSwipeRight 调用一次', () => {
    const right = vi.fn();
    renderDeck(undefined, right);
    swipeBy(120);
    expect(right).toHaveBeenCalledTimes(1);
  });

  it('位移不足阈值 → 不触发回调', () => {
    const left = vi.fn();
    renderDeck(left);
    swipeBy(-40);
    expect(left).not.toHaveBeenCalled();
  });

  it('垂直主导的滑动 → 不触发回调', () => {
    const left = vi.fn();
    renderDeck(left);
    fireEvent.touchStart(area(), { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(area(), { touches: [{ clientX: 210, clientY: 420 }] });
    fireEvent.touchEnd(area(), { changedTouches: [{ clientX: 212, clientY: 480 }] });
    expect(left).not.toHaveBeenCalled();
  });

  it('handler 返回 false → 不抛错（边界回弹）', () => {
    const left = vi.fn(() => false);
    renderDeck(left);
    expect(() => swipeBy(-120)).not.toThrow();
    expect(left).toHaveBeenCalledTimes(1);
  });

  it('触摸起点在按钮上 → 不触发手势（交互元素防护）', () => {
    const right = vi.fn();
    renderDeck(undefined, right);
    const btn = screen.getByRole('button', { name: '按钮' });
    fireEvent.touchStart(btn, { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(area(), { touches: [{ clientX: 320, clientY: 300 }] });
    fireEvent.touchEnd(area(), { changedTouches: [{ clientX: 320, clientY: 300 }] });
    expect(right).not.toHaveBeenCalled();
  });

  it('跟手位移作用于 [data-swipe-card]，手势结束后复位', () => {
    renderDeck();
    const el = card();
    fireEvent.touchStart(area(), { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(area(), { touches: [{ clientX: 100, clientY: 300 }] });
    expect(el.style.transform).toContain('translateX(');
    fireEvent.touchEnd(area(), { changedTouches: [{ clientX: 80, clientY: 300 }] });
  });
});
```

- [ ] **Step 2: 改 today-navigation 单测的 swipeBy 选择器**

`apps/web/tests/today-navigation.test.tsx` 第 38 行：

```ts
  const el = document.querySelector('[data-swipe-area]');
```

- [ ] **Step 3: 跑单测确认失败**

Run: `pnpm --filter @el/web run test`
Expected: swipe-deck 相关用例 FAIL（找不到 `[data-swipe-area]` / 按钮防护用例失败），today-navigation 现有用例也因选择器 FAIL。

- [ ] **Step 4: 重写 SwipeDeck.tsx**

整文件替换为：

```tsx
import { useEffect, useRef, type ReactNode } from 'react';

const THRESHOLD_PX = 60;
/** 水平判定比例：|dx| 必须超过 |dy| 的 1.5 倍 */
const H_RATIO = 1.5;
/** 触摸起点命中交互元素时不接管手势（点击/输入/弹层归它们自己） */
const IGNORE_SELECTOR = 'button, input, textarea, select, a, [role="dialog"], [data-no-swipe]';

interface SwipeDeckProps {
  onSwipeLeft: () => boolean | void;
  onSwipeRight: () => boolean | void;
  className?: string;
  children: ReactNode;
}

/**
 * 页面级滑动翻页容器：手势监听在整个会话区块（进度行+卡片+留白），
 * 跟手 translateX/rotateY 位移只作用于内部 [data-swipe-card] 目标。
 * 松手超过阈值翻页（旧卡滑出、新卡对侧滑入），否则回弹；handler 返回 false = 边界回弹。
 * prefers-reduced-motion 时跳过所有动画，仅保留手势判定。
 */
export function SwipeDeck({ onSwipeLeft, onSwipeRight, className, children }: SwipeDeckProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  /** 翻页滑出动画的 setTimeout id；新手势/卸载时取消，避免旧回调打断新一轮动画 */
  const slideTimer = useRef<number | null>(null);

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clearSlideTimer() {
    if (slideTimer.current !== null) {
      window.clearTimeout(slideTimer.current);
      slideTimer.current = null;
    }
  }

  // 卸载时清理挂起的翻页动画回调
  useEffect(() => () => clearSlideTimer(), []);

  function setTransform(dx: number, animated: boolean, ms = 200) {
    const el = areaRef.current?.querySelector<HTMLElement>('[data-swipe-card]');
    if (!el) return;
    el.style.transition = animated ? `transform ${ms}ms ease-out` : 'none';
    el.style.transform = dx === 0 ? '' : `translateX(${dx}px) rotateY(${dx * 0.06}deg)`;
  }

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    clearSlideTimer();
    if ((e.target as Element).closest?.(IGNORE_SELECTOR)) {
      start.current = null; // 交互元素：不接管
      return;
    }
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
    clearSlideTimer();
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
    slideTimer.current = window.setTimeout(() => {
      slideTimer.current = null;
      setTransform(dx < 0 ? 60 : -60, false);
      requestAnimationFrame(() => setTransform(0, true, 200));
    }, 250);
  }

  /** 浏览器接管手势（滚动/系统手势）：与"未构成滑动"一致，回弹到中位 */
  function onTouchCancel() {
    start.current = null;
    dragging.current = false;
    if (!reducedMotion) setTransform(0, true);
  }

  return (
    <div
      ref={areaRef}
      data-swipe-area
      className={className}
      /* pan-y：横向手势留给组件，纵向滚动归浏览器 */
      style={{ touchAction: 'pan-y', perspective: '1200px' }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 5: 改 ActiveSession render（组合调整）**

`apps/web/src/features/today/components/ActiveSession.tsx` 最后的 return（约 284-322 行）替换为（保留 reviewing 三元块到 Task 2，其余现状不变，仅结构变化）：

```tsx
  return (
    <SwipeDeck className="space-y-4" onSwipeLeft={handleSwipeLeft} onSwipeRight={handleSwipeRight}>
      <ProgressRow
        progress={progress}
        entries={entries}
        currentIdx={currentIdx}
        shownIdx={shownIdx}
        onJump={(i) => setCursor(i)}
      />

      <div data-swipe-card style={{ willChange: 'transform', backfaceVisibility: 'hidden' }}>
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
    </SwipeDeck>
  );
```

注意：这一步先**保留** `{reviewing ? <button ...>返回当前</button> : null}` 块在 SwipeDeck 内 ProgressRow 之前（Task 2 再删），避免跨任务耦合。即 return 实际为：

```tsx
  return (
    <SwipeDeck className="space-y-4" onSwipeLeft={handleSwipeLeft} onSwipeRight={handleSwipeRight}>
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

      <ProgressRow ……（同上） />
      <div data-swipe-card ……>（同上） </div>
    </SwipeDeck>
  );
```

- [ ] **Step 6: 跑单测确认通过**

Run: `pnpm --filter @el/web run test`
Expected: 全部 PASS。

- [ ] **Step 7: 写 e2e 页面级手势用例（先失败验证可选，直接实现后跑通）**

`apps/web/e2e/today.spec.ts`：文件头部 helper 区（`continueAfterCorrect` 之后）新增：

```ts
/** 在页面坐标 (x, y) 以真实 TouchEvent 序列横向滑 dx 像素（冒泡到 React 根） */
async function touchSwipe(page: Page, x: number, y: number, dx: number) {
  await page.evaluate(
    ([sx, sy, d]) => {
      const target = document.elementFromPoint(sx, sy);
      if (!target) throw new Error('elementFromPoint 命中为空');
      const mk = (type: string, cx: number) => {
        const t = new Touch({
          identifier: 1,
          target,
          clientX: cx,
          clientY: sy,
          radiusX: 1,
          radiusY: 1,
          rotationAngle: 0,
          force: 1,
        });
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === 'touchend' ? [] : [t],
            targetTouches: type === 'touchend' ? [] : [t],
            changedTouches: [t],
          }),
        );
      };
      mk('touchstart', sx);
      mk('touchmove', sx + d / 2);
      mk('touchend', sx + d);
    },
    [x, y, dx],
  );
}
```

describe 内新增用例（放在现有 '导航：列表回看与跳做未完成任务' 之后）：

```ts
  test('手势：卡片外区域起滑可翻页；按钮起滑不翻页', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();

    // 首卡 give up 表达题：提交通过 → 手动下一题，当前推进到第 2/6（make sense）
    await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();
    await page.getByLabel('表达答案').fill('The constant stress makes me want to give up.');
    await page.getByRole('button', { name: '提交' }).click();
    await expect(page.getByText('通过', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一题' }).click();
    await expect(page.getByText(/^第 2 \/ \d+$/)).toBeVisible();

    // 卡片正上方间隙（进度行与卡片之间的 space-y-4 留白）起左滑 → 回看上一题
    const card = (await page.locator('[data-swipe-card]').boundingBox())!;
    await touchSwipe(page, card.x + card.width / 2, card.y - 8, -160);
    await expect(page.getByText(/^第 1 \/ \d+$/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'give up' })).toBeVisible();

    // "查看任务列表"按钮中心起滑 → 手势被防护忽略，仍停留第 1
    const listBtn = (await page.getByRole('button', { name: '查看任务列表' }).boundingBox())!;
    await touchSwipe(page, listBtn.x + listBtn.width / 2, listBtn.y + listBtn.height / 2, 160);
    await page.waitForTimeout(300);
    await expect(page.getByText(/^第 1 \/ \d+$/)).toBeVisible();
    await expect(page.getByRole('dialog', { name: '任务列表' })).toBeHidden();
  });
```

- [ ] **Step 8: 跑新 e2e + 既有导航 e2e**

Run: `pnpm --filter @el/web run e2e -- -g "手势"`
Expected: PASS。
Run: `pnpm --filter @el/web run e2e -- -g "导航"`
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/today/components/SwipeDeck.tsx apps/web/src/features/today/components/ActiveSession.tsx apps/web/tests/swipe-deck.test.tsx apps/web/tests/today-navigation.test.tsx apps/web/e2e/today.spec.ts
git commit -m "feat(web): 会话手势升级为页面级——区块任意位置可滑，交互元素防护

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 2: 移除"返回当前"按钮

**Files:**
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx`（删按钮块 + `ChevronLeft` import）
- Test: `apps/web/e2e/today.spec.ts:184`（改用列表点"当前"项路径 + 断言按钮不存在）

**Interfaces:**
- Consumes: Task 1 的 SwipeDeck 结构；回当前既有路径：右滑越过末尾（`stepCursor`）、列表点当前项（`onJump(null)`）。

- [ ] **Step 1: 改 e2e（新路径 + 不存在断言）**

`apps/web/e2e/today.spec.ts` 第 183-184 行：

```ts
    await expect(page.getByRole('heading', { name: 'give up' })).toBeVisible();
    await page.getByRole('button', { name: '返回当前' }).click();
```

替换为：

```ts
    await expect(page.getByRole('heading', { name: 'give up' })).toBeVisible();
    // 返回当前：列表点"当前"项（make sense，第 2/6）
    await page.getByRole('button', { name: '查看任务列表' }).click();
    await dialog.getByRole('button', { name: /make sense/ }).click();
    await expect(page.getByText(/^第 2 \/ \d+$/)).toBeVisible();
    await expect(page.getByRole('button', { name: '返回当前' })).toHaveCount(0);
```

- [ ] **Step 2: 跑 e2e 确认失败**

Run: `pnpm --filter @el/web run e2e -- -g "导航"`
Expected: FAIL（`返回当前` 按钮仍存在，`toHaveCount(0)` 断言失败）。

- [ ] **Step 3: 删除按钮**

`apps/web/src/features/today/components/ActiveSession.tsx`：

第 3 行 import 改为：

```ts
import { Check, X } from 'lucide-react';
```

删除 SwipeDeck 内的 reviewing 按钮块：

```tsx
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
```

- [ ] **Step 4: 跑单测 + e2e 确认通过**

Run: `pnpm --filter @el/web run test`
Expected: PASS（单测无按钮引用）。
Run: `pnpm --filter @el/web run e2e -- -g "导航"`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/today/components/ActiveSession.tsx apps/web/e2e/today.spec.ts
git commit -m "refactor(web): 移除回看态\"返回当前\"按钮——右滑越过末尾/列表点当前即回

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 3: 答对自动跳题单次武装

**Files:**
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx:216-222`（自动跳题 effect + 新增 armedRef）
- Test: `apps/web/tests/today-navigation.test.tsx`（新增 2 用例）
- Test: `apps/web/e2e/today.spec.ts`（新增回归用例）

**Interfaces:**
- Consumes: 既有 `FrozenAnswer`（对象引用即作答身份）；`CORRECT_AUTO_ADVANCE_MS = 4000`。
- Produces: 语义"一次作答最多武装一次"——armedRef 记录已武装的 frozen 对象，effect 跳过同对象重复武装。

- [ ] **Step 1: 写失败单测（today-navigation.test.tsx describe 末尾新增）**

```ts
  /** 答对 t3（understanding 自动推进型）后桩切换：currentTask → t4 */
  function stubAnsweredSession() {
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
  }

  it('答对不动 → 4s 自动跳题（基线行为）', async () => {
    stubAnsweredSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '稳定的' }));
    await screen.findByText('回答正确');
    // CORRECT_AUTO_ADVANCE_MS(4s) 后自动推进到 t4
    await screen.findByRole('heading', { name: 'delta' }, { timeout: 7000 });
  }, 10_000);

  it('答对后回看返回当前：不再重新武装自动跳题', async () => {
    stubAnsweredSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '稳定的' }));
    await screen.findByText('回答正确');
    // 4s 内左滑回看（取消本次倒计时），再右滑回当前
    swipeBy(-120);
    await screen.findByText('第 2 / 4');
    swipeBy(120);
    await screen.findByText('第 3 / 4');
    expect(screen.getByRole('heading', { name: 'gamma' })).toBeVisible();
    // 超过 CORRECT_AUTO_ADVANCE_MS：不得自动跳题（旧代码此处会推进到 delta）
    await new Promise((r) => setTimeout(r, 5000));
    expect(screen.getByRole('heading', { name: 'gamma' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'delta' })).toBeNull();
    // 手动右滑（冻结反馈态右滑 = onAdvance）仍可进入下一题
    swipeBy(120);
    await screen.findByRole('heading', { name: 'delta' });
  }, 20_000);
```

- [ ] **Step 2: 跑单测确认失败**

Run: `pnpm --filter @el/web run test -- today-navigation`
Expected: '答对后回看返回当前' 用例 FAIL（5s 后被推进到 delta，gamma 断言失败）；'基线行为' 用例 PASS。

- [ ] **Step 3: 实现 armedRef**

`apps/web/src/features/today/components/ActiveSession.tsx`：

import 区补 `useRef`（第 1 行）：

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
```

组件内（`const [hold, setHold] = useState(false);` 之后）新增：

```ts
  /** 已武装过自动跳题的作答：一次作答最多武装一次，中途离开/按住后不再重置 */
  const armedRef = useRef<FrozenAnswer | null>(null);
```

自动跳题 effect（约 216-222 行）替换为：

```ts
  // 答对自动下一题：仅作答瞬间武装一次；回看/按住中断后返回当前不重新武装
  useEffect(() => {
    if (cursor !== null) return;
    if (!frozen || !frozen.result.correct || MANUAL_ADVANCE_TYPES.has(frozen.task.taskType) || hold)
      return;
    if (armedRef.current === frozen) return;
    armedRef.current = frozen;
    const timer = setTimeout(onAdvance, CORRECT_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [frozen, hold, onAdvance, cursor]);
```

- [ ] **Step 4: 跑单测确认通过**

Run: `pnpm --filter @el/web run test`
Expected: 全部 PASS。

- [ ] **Step 5: 写 e2e 回归用例（today.spec.ts describe 末尾新增）**

```ts
  test('倒计时：答对后回看返回当前不自动跳题，手动右滑进下一题', async ({ page }) => {
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

    // make sense 答对（自动推进型）→ 立即卡片左滑回看 give up
    await page.getByRole('button', { name: '讲得通' }).click();
    await expect(page.getByText('回答正确')).toBeVisible();
    const card = (await page.locator('[data-swipe-card]').boundingBox())!;
    await touchSwipe(page, card.x + card.width / 2, card.y + card.height / 2, -160);
    await expect(page.getByText(/^第 1 \/ \d+$/)).toBeVisible();

    // 列表点"当前"项回当前（make sense 反馈仍冻结显示）
    await page.getByRole('button', { name: '查看任务列表' }).click();
    const dialog = page.getByRole('dialog', { name: '任务列表' });
    await dialog.getByRole('button', { name: /make sense/ }).click();
    await expect(page.getByText(/^第 2 \/ \d+$/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();

    // 超过 4s 自动跳题窗口：不得推进（旧代码会跳到 raw 填空）
    await page.waitForTimeout(5000);
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();

    // 手动右滑 → 进入下一题 raw 填空
    await page.keyboard.press('ArrowRight');
    await expect(page.getByLabel('填空答案')).toBeVisible();
  });
```

- [ ] **Step 6: 跑该 e2e**

Run: `pnpm --filter @el/web run e2e -- -g "倒计时"`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/today/components/ActiveSession.tsx apps/web/tests/today-navigation.test.tsx apps/web/e2e/today.spec.ts
git commit -m "fix(web): 答对自动跳题仅作答瞬间武装一次——回看/按住中断后不再重置

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 4: 全量验证

**Files:** 无新改动（验证型任务）。

- [ ] **Step 1: typecheck**

Run: `pnpm --filter @el/web run typecheck`
Expected: 无错误退出。

- [ ] **Step 2: 全部单测**

Run: `pnpm --filter @el/web run test`
Expected: 全部 PASS。

- [ ] **Step 3: 全量 e2e（独占运行，勿与其他构建并发）**

Run: `pnpm --filter @el/web run e2e`
Expected: 全部 PASS（含既有 6 个 spec 文件的今天改动脉络）。

- [ ] **Step 4: 生产构建**

Run: `NODE_OPTIONS=--max-old-space-size=768 pnpm --filter @el/web run build`
Expected: `✓ built in` 成功（tsc --noEmit + vite build）。

（无提交；部署与推送由编排者在审查后统一执行。）
