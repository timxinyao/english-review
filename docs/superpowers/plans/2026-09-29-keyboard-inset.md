# iOS 键盘避让（--kb-inset）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** iPhone 软键盘弹起时输入框贴键盘上沿、顶栏与题干不动、document 不被顶起；机制全局、Today 先消费。

**Architecture:** 单例模块监听 `window.visualViewport`，把键盘遮挡高度写入 `<html>` 的 CSS 变量 `--kb-inset` 并以 `useSyncExternalStore` 暴露数值；Today 卡高公式消费该变量压缩卡身，ActiveSession 在键盘期锁 `body` 滚动。Android Chromium 由 viewport meta `interactive-widget=resizes-content` 获得同等收缩。

**Tech Stack:** React 18 + TypeScript、Tailwind v4 `@utility`、Vitest + Testing Library、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-29-keyboard-inset-design.md`。

## Global Constraints

- 纯 web 改动：不碰 API、数据库、packages/shared 契约；不改 Library Practice 行为。
- 样式规则（AGENTS.md §9A）：tokens 唯一来源 globals.css，feature 代码禁 hex/内联样式；本计划只新增 `--kb-inset` 消费，不新增颜色 token。
- `window.visualViewport` 不存在时全部行为 no-op（jsdom/旧浏览器安全）。
- 测试一律串行跑（服务器 1.9G 内存）；E2E 用 `pnpm --filter @el/web exec playwright test`，端口冲突时 `E2E_API_PORT=5175`，不稳时 `--workers=1`。
- 工作区有用户未提交改动 `.claude/skills/import-english/SKILL.md`：不 stage、不改动、不提交。
- 提交信息中文、`feat(web)/test(web)/fix(web)` 前缀，正文末尾：

  ```
  Co-Authored-By: HAPI <noreply@hapi.run>
  ```

## File map and interfaces

| Unit | Files | Responsibility |
| --- | --- | --- |
| 全局机制 | `apps/web/src/lib/keyboard-inset.ts`（新）、`apps/web/src/app/shell.tsx`、`apps/web/index.html` | visualViewport 单例监听、`--kb-inset` 写入、`useKeyboardInset()` hook、meta rider |
| Today 消费 | `apps/web/src/styles/globals.css`、`apps/web/src/features/today/components/ActiveSession.tsx` | 卡高公式减 inset；键盘期锁 body 滚动 |
| 测试 | `apps/web/tests/keyboard-inset.test.tsx`（新）、`apps/web/tests/today-keyboard-lock.test.tsx`（新）、`apps/web/e2e/today.spec.ts` | 机制单测、滚动锁单测、注入变量的几何 E2E |

Interfaces:
- Task 1 产出：`useKeyboardInset(): number`（`apps/web/src/lib/keyboard-inset.ts`）；副作用约定——首个订阅启动监听、最后一个退订移除监听（app 生命周期内常驻）；CSS 变量 `--kb-inset` 写在 `document.documentElement.style`，值为 `${n}px`，键盘收起为 `0px`。
- Task 2 消费：`h-today-viewport` 高度追加 `- var(--kb-inset, 0px)`；ActiveSession 内 `keyboardLocked = useKeyboardInset() > 0` 时 `document.body.style.overflow = 'hidden'`，解锁/卸载恢复原值。

---

### Task 1: 全局 keyboard-inset 机制

**Files:**
- Create: `apps/web/src/lib/keyboard-inset.ts`
- Modify: `apps/web/src/app/shell.tsx`（挂载 hook）
- Modify: `apps/web/index.html`（meta 追加 `interactive-widget=resizes-content`）
- Test: `apps/web/tests/keyboard-inset.test.tsx`（新）

**Interfaces:**
- Produces: `useKeyboardInset(): number` 与 CSS 变量 `--kb-inset`（见上）。

- [ ] **Step 1: 写失败测试** `apps/web/tests/keyboard-inset.test.tsx`

```tsx
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeVisualViewport extends EventTarget {
  height = 700;
  offsetTop = 0;
}

async function loadModule() {
  vi.resetModules();
  return await import('../src/lib/keyboard-inset');
}

function setInnerHeight(value: number) {
  Object.defineProperty(window, 'innerHeight', { value, configurable: true, writable: true });
}

describe('keyboard-inset', () => {
  beforeEach(() => {
    setInnerHeight(844);
  });

  afterEach(() => {
    delete (window as { visualViewport?: unknown }).visualViewport;
    document.documentElement.style.removeProperty('--kb-inset');
  });

  it('键盘弹起：inset = round(innerHeight - vv.height - vv.offsetTop)，写入 --kb-inset', async () => {
    (window as { visualViewport?: unknown }).visualViewport = new FakeVisualViewport();
    const { useKeyboardInset } = await loadModule();
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(144);
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('144px');
  });

  it('键盘收起（差值为负）夹取为 0', async () => {
    const vv = new FakeVisualViewport();
    vv.height = 844;
    (window as { visualViewport?: unknown }).visualViewport = vv;
    const { useKeyboardInset } = await loadModule();
    renderHook(() => useKeyboardInset());
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('0px');
  });

  it('offsetTop 计入（iOS 键盘伴随视口上移）', async () => {
    const vv = new FakeVisualViewport();
    vv.height = 600;
    vv.offsetTop = 100;
    (window as { visualViewport?: unknown }).visualViewport = vv;
    const { useKeyboardInset } = await loadModule();
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(144); // 844 - 600 - 100
  });

  it('resize 更新数值与变量；最后一个退订后移除监听、变量不再变化', async () => {
    const vv = new FakeVisualViewport();
    const removeSpy = vi.spyOn(vv, 'removeEventListener');
    (window as { visualViewport?: unknown }).visualViewport = vv;
    const { useKeyboardInset } = await loadModule();
    const { result, unmount } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(144);

    vv.height = 500;
    vv.dispatchEvent(new Event('resize'));
    expect(result.current).toBe(344);
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('344px');

    unmount();
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    vv.height = 700;
    vv.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('344px');
  });

  it('无 visualViewport 时 no-op 返回 0', async () => {
    const { useKeyboardInset } = await loadModule();
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @el/web exec vitest run tests/keyboard-inset.test.tsx`
Expected: FAIL——模块不存在（import 解析失败）。

- [ ] **Step 3: 实现** `apps/web/src/lib/keyboard-inset.ts`

```ts
import { useSyncExternalStore } from 'react';

/**
 * iOS 软键盘避让（spec docs/superpowers/specs/2026-09-29-keyboard-inset-design.md）：
 * 把键盘遮挡高度写进 <html> 的 --kb-inset 供布局消费（Today 卡高公式），
 * 并暴露 useKeyboardInset() 数值（Today 键盘期滚动锁）。
 * 单例：首个订阅启动监听，最后一个退订移除监听；app 生命周期内常驻。
 * 无 window.visualViewport（jsdom/旧浏览器）时安全 no-op。
 */
let currentInset = 0;
const subscribers = new Set<() => void>();

function computeInset(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

function publish() {
  const next = computeInset();
  if (next === currentInset) return;
  currentInset = next;
  document.documentElement.style.setProperty('--kb-inset', `${currentInset}px`);
  subscribers.forEach((notify) => notify());
}

function start() {
  const vv = window.visualViewport;
  if (!vv) return;
  vv.addEventListener('resize', publish);
  vv.addEventListener('scroll', publish);
  publish();
}

function stop() {
  const vv = window.visualViewport;
  if (!vv) return;
  vv.removeEventListener('resize', publish);
  vv.removeEventListener('scroll', publish);
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  if (subscribers.size === 1) start();
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) stop();
  };
}

const getSnapshot = () => currentInset;

export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
```

- [ ] **Step 4: shell 挂载 + meta rider**

`apps/web/src/app/shell.tsx`：在组件顶部（其他 hooks 旁）加一行调用，保持常驻订阅：

```tsx
import { useKeyboardInset } from '../lib/keyboard-inset';
// AppShell 组件体内：
  useKeyboardInset(); // 常驻订阅：软键盘 --kb-inset 全局生效（今日卡消费）
```

`apps/web/index.html` viewport meta 改为：

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content" />
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @el/web exec vitest run tests/keyboard-inset.test.tsx tests/app-shell.test.tsx`
Expected: PASS（app-shell 既有用例不受影响——jsdom 无 visualViewport，hook no-op）。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib/keyboard-inset.ts apps/web/src/app/shell.tsx apps/web/index.html apps/web/tests/keyboard-inset.test.tsx
git commit -m "feat(web): 全局键盘避让机制——visualViewport 单例写 --kb-inset，shell 常驻订阅，Android 加 interactive-widget"
```

（提交正文末尾带 Global Constraints 里的 Co-Authored-By。）

---

### Task 2: Today 卡高消费与键盘期滚动锁

**Files:**
- Modify: `apps/web/src/styles/globals.css:111-113`（`@utility h-today-viewport`）
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx`
- Test: `apps/web/tests/today-keyboard-lock.test.tsx`（新）
- Test: `apps/web/e2e/today.spec.ts`（mobile describe 内加用例）

**Interfaces:**
- Consumes: `useKeyboardInset(): number`（Task 1）；`--kb-inset` CSS 变量。
- Produces: 无（末端消费）。

- [ ] **Step 1: 写失败的滚动锁单测** `apps/web/tests/today-keyboard-lock.test.tsx`

```tsx
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeActive, makeChoiceTask, makeSessionEntry, makeTasksResponse, renderTodayApp, stubApi } from './today-helpers';

const kb = { inset: 0 };
vi.mock('../src/lib/keyboard-inset', () => ({ useKeyboardInset: () => kb.inset }));

function renderActiveSession() {
  const task = makeChoiceTask();
  stubApi({
    '/api/today': () => makeActive(task),
    '/api/today/tasks': () => makeTasksResponse([makeSessionEntry(task, null)]),
  });
  renderTodayApp();
}

describe('Today 键盘期 body 滚动锁', () => {
  beforeEach(() => {
    kb.inset = 0;
    document.body.style.overflow = '';
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
  });

  it('键盘弹起（inset>0）锁 body，卸载恢复', async () => {
    kb.inset = 320;
    renderActiveSession();
    await screen.findByRole('heading', { name: 'gravity' });
    expect(document.body.style.overflow).toBe('hidden');
    cleanup();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('键盘收起（inset=0）不锁', async () => {
    renderActiveSession();
    await screen.findByRole('heading', { name: 'gravity' });
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @el/web exec vitest run tests/today-keyboard-lock.test.tsx`
Expected: FAIL——第一条 `expect(document.body.style.overflow).toBe('hidden')` 收到 `''`（锁未实现）。

- [ ] **Step 3: 写失败的 E2E 用例**（`apps/web/e2e/today.spec.ts` 的 `test.use({ viewport: { width: 375, height: 480 } })` describe 内，紧随既有短屏用例之后）

```ts
  test('键盘避让：注入 --kb-inset 后卡身压缩、顶栏不动、输入停靠键盘线上', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();
    await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();

    const card = page.locator('article').first();
    const nav = page.locator('nav.fixed');
    const header = page.locator('header.fixed');
    const cardBefore = (await card.boundingBox())!;
    const headerBefore = (await header.boundingBox())!;

    await page.evaluate(() =>
      document.documentElement.style.setProperty('--kb-inset', '260px'),
    );

    const cardAfter = (await card.boundingBox())!;
    const headerAfter = (await header.boundingBox())!;
    const navBox = (await nav.boundingBox())!;
    expect(headerAfter.y).toBe(headerBefore.y); // 顶栏不动
    expect(cardAfter.y).toBe(cardBefore.y); // 卡顶不动（压缩发生在底部）
    expect(cardAfter.height).toBeLessThan(cardBefore.height); // 卡身压缩
    expect(navBox.y - (cardAfter.y + cardAfter.height)).toBeGreaterThanOrEqual(258); // 卡底 ≈ 键盘线
    const inputBox = (await page.getByLabel('表达答案').boundingBox())!;
    expect(navBox.y - (inputBox.y + inputBox.height)).toBeGreaterThanOrEqual(258); // 输入框在键盘线上
  });
```

（容差 2px：`>= 258` 即 `260 - 2`。若断言选择器与现行 DOM 有出入，以既有短屏用例的选择器为准对齐——`article`/`nav.fixed`/`header.fixed`/`表达答案` 均出自同一 describe 的既有用例。）

- [ ] **Step 4: 跑 E2E 确认失败**

Run: `pnpm --filter @el/web exec playwright test today.spec.ts -g "键盘避让"`
Expected: FAIL——卡高公式尚未消费 `--kb-inset`，注入后卡底仍贴 nav（`>= 258` 断言收到约 0）。端口冲突加 `E2E_API_PORT=5175`，不稳加 `--workers=1`。

- [ ] **Step 5: 实现滚动锁 + 卡高消费**

`apps/web/src/features/today/components/ActiveSession.tsx`：加 import 与 effect（放在既有 state 声明之后）：

```tsx
import { useKeyboardInset } from '../../../lib/keyboard-inset';
// 组件体内：
  const keyboardInset = useKeyboardInset();
  const keyboardLocked = keyboardInset > 0;
  useEffect(() => {
    if (!keyboardLocked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [keyboardLocked]);
```

`apps/web/src/styles/globals.css` 的 `@utility h-today-viewport` 改为：

```css
@utility h-today-viewport {
  height: calc(100dvh - var(--header-block) - 0.75rem - var(--nav-block) - var(--kb-inset, 0px));
}
```

- [ ] **Step 6: 跑单测与 E2E 确认通过**

Run: `pnpm --filter @el/web exec vitest run tests/today-keyboard-lock.test.tsx tests/today-active.test.tsx tests/today-navigation.test.tsx`
Expected: PASS（Today 既有用例不受影响）。

Run: `pnpm --filter @el/web exec playwright test today.spec.ts -g "键盘避让"`
Expected: PASS（1 用例）。

- [ ] **Step 7: 全量门禁（串行）**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e
```

Expected: 全部 exit 0（e2e 需要时 `E2E_API_PORT=5175 pnpm e2e`）。真机验收（用户 iPhone，Safari 与主屏 PWA）在部署后进行，验收点见 spec「测试与验收」。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/styles/globals.css apps/web/src/features/today/components/ActiveSession.tsx apps/web/tests/today-keyboard-lock.test.tsx apps/web/e2e/today.spec.ts
git commit -m "feat(web): Today 键盘避让——卡高减 --kb-inset 输入停靠键盘线，键盘期锁 body 滚动"
```

（提交正文末尾带 Co-Authored-By。）
