# Read 生成修复 + 耗时显示 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read 生成从"必失败"变可靠（focus 3 + prompt 强化 + 错误日志）；Read/开始流程生成中显示正计时，Read 完成后显示总耗时。

**Architecture:** shared 常量 + prompt 文本 + 一处 console.error（API）；新 ElapsedTimer 组件与两处接入（web）。无接口变更。

**Tech Stack:** 同前（Fastify/drizzle、React 18、vitest、Playwright）。

**规格：** `docs/superpowers/specs/2026-09-27-read-gen-fix-and-elapsed-design.md`

## Global Constraints

- 仓库根：`/var/www/english-review`；API 单测 `pnpm --filter @el/api run test`、web 单测 `pnpm --filter @el/web run test`（均须全过）；typecheck 两侧无错误。
- e2e：`E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "Read"`。
- 提交信息末尾加：
  ```
  via [HAPI](https://hapi.run)

  Co-Authored-By: HAPI <noreply@hapi.run>
  ```
- 不要 push、不要部署（编排者统一做）。

---

### Task 1: API——Read 生成成功率修复

**Files:**
- Modify: `packages/shared/src/constants/app.ts:19`（READ_FOCUS_MAX 5→3）
- Modify: `apps/api/prompts/generate_read.v1.md`（coverage 指令强化）
- Modify: `apps/api/src/modules/read/service.ts`（generateReadArticle catch 落日志）
- Test: buildReadSelection 相关既有单测（grep 定位）+ 新增错误日志用例

**Interfaces:**
- Consumes: 既有 `buildReadSelection`、prompt 文件就地强化（无版本机制变更——先读 `apps/api/src/ai/promptRegistry` 的加载逻辑确认 hash 按内容计算；若注册表硬编码文件清单，确认 generate_read.v1 仍在清单）。
- Produces: `READ_FOCUS_MAX = 3`；generateReadArticle 失败必落 `console.error('[read/generate]', <原始错误>)`。

- [ ] **Step 1: 改/写单测（RED）**

1a. `grep -rn 'READ_FOCUS_MAX\|focus' apps/api/tests --include='*.ts' -l` 定位选词测试文件；把 focus 数量上限相关断言从 5 改为 3（若断言是"≤5"改为"≤3"；种子数据多于 3 个弱项的用例应断言只取 3）。

1b. 在 read 生成相关测试文件新增（沿用其 fake deps 手法）：

```ts
  it('生成失败：真实原因落 console.error，再抛通用 502', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // deps.generate mock 为抛 AiStructuredError('输出违反不变式：focus item xxx 未出现在 coverage')
    // 断言：await expect(...).rejects.toThrow('文章生成失败，请稍候重试')
    //      errSpy 最后一次调用第二参包含 '未出现在 coverage'
    errSpy.mockRestore();
  });
```

（AiStructuredError 的 import 路径以 service 现有 import 为准；若该错误类未被 read/service 引用过，从 `../../ai/complete.js` 导入仅用于测试抛出同类型。）

- [ ] **Step 2: 跑单测确认 RED**

Run: `pnpm --filter @el/api run test -- read`
Expected: 1a 数量断言 FAIL（仍取 5）；1b FAIL（无日志）。

- [ ] **Step 3: 实现**

3a. `packages/shared/src/constants/app.ts`：`READ_FOCUS_MAX = 5` → `3`（注释如有"3–5"表述改为"取 3：coverage 漏报率随词数上升，2026-09-27 实测 5 必漏/3 成功"）。

3b. `apps/api/prompts/generate_read.v1.md` 第 38 行 coverage 规则替换为：

```markdown
8. `coverage` 必须逐一包含**全部** focus item（每个 focus_items 里的 learning_item_id 都要出现，缺一不可）。写完后自查：coverage 条数 ≥ focus_items 条数，且每个 learning_item_id 都对得上。每个条目列出该词实际在 body 中使用的 surface_form。若无法自然使用某个 focus item，不要假装覆盖，应重新组织文章。
```

（保留该行原有其余约束；确认清单/示例段与第 68 行自查文案不冲突，如有"所有 focus item 都在 coverage 中"重复表述保留即可。）

3c. `generateReadArticle` 的 catch：

```ts
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error('[read/generate] 生成失败：', err instanceof Error ? err.message : err);
    throw appError('AI_PROVIDER_ERROR', '文章生成失败，请稍候重试');
  }
```

- [ ] **Step 4: 跑单测确认 GREEN + 全量**

Run: `pnpm --filter @el/api run test` → 全过。

- [ ] **Step 5: typecheck + Commit**

Run: `pnpm --filter @el/api run typecheck`（或既有脚本）→ 无错误。

```bash
git add packages/shared/src/constants/app.ts apps/api/prompts/generate_read.v1.md apps/api/src/modules/read/service.ts apps/api/tests
git commit -m "fix(api): Read 生成必失败——focus 降 3 + coverage 指令强化 + 失败原因落日志

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 2: Web——正计时与耗时显示

**Files:**
- Create: `apps/web/src/components/elapsed-timer.tsx`
- Modify: `apps/web/src/features/read/ReadPage.tsx`
- Modify: `apps/web/src/features/today/components/StartSessionDialog.tsx`
- Test: `apps/web/tests/elapsed-timer.test.tsx`（新建）、`apps/web/tests/start-session-dialog.test.tsx`（扩展）

**Interfaces:**
- Produces: `export function ElapsedTimer({ since }: { since: number }): JSX.Element`——`since` 为起始 epoch ms；渲染 `<span data-elapsed>mm:ss</span>`（≥1h 为 `h:mm:ss`）；组件卸载清理定时器。

- [ ] **Step 1: 写失败单测**

1a. `apps/web/tests/elapsed-timer.test.tsx`：

```tsx
import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElapsedTimer } from '../src/components/elapsed-timer';

afterEach(cleanup);

describe('ElapsedTimer', () => {
  it('起始 00:00，每秒递增', async () => {
    vi.useFakeTimers();
    render(<ElapsedTimer since={Date.now()} />);
    expect(screen.getByText('00:00')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText('00:03')).toBeTruthy();
    vi.useRealTimers();
  });

  it('满一小时进位 h:mm:ss', async () => {
    vi.useFakeTimers();
    render(<ElapsedTimer since={Date.now()} />);
    await act(async () => { vi.advanceTimersByTime(3_600_000 + 65_000); });
    expect(screen.getByText('1:01:05')).toBeTruthy();
    vi.useRealTimers();
  });

  it('卸载清理定时器（无泄漏告警）', () => {
    vi.useFakeTimers();
    const { unmount } = render(<ElapsedTimer since={Date.now()} />);
    unmount();
    expect(() => vi.runAllTimers()).not.toThrow();
    vi.useRealTimers();
  });
});
```

1b. `start-session-dialog.test.tsx` 的"生成中"用例追加断言（pending 渲染时存在 `data-elapsed` 元素、文案以"已等待"开头）。

- [ ] **Step 2: 跑单测确认 RED**

Run: `pnpm --filter @el/web run test -- elapsed-timer`
Expected: FAIL（组件不存在）；dialog 扩展断言 FAIL。

- [ ] **Step 3: 实现**

3a. `apps/web/src/components/elapsed-timer.tsx`：

```tsx
import { useEffect, useState } from 'react';

function format(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 正计时：since（epoch ms）起每秒刷新的 mm:ss（≥1h 为 h:mm:ss） */
export function ElapsedTimer({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span data-elapsed>{format(Math.max(0, now - since))}</span>;
}
```

3b. `ReadPage.tsx`：
- 组件内 `const [genStart, setGenStart] = useState<number | null>(null);` 与 `const [lastElapsed, setLastElapsed] = useState<number | null>(null);`
- `generateOnce` 开头 `setGenStart(Date.now()); setLastElapsed(null);`
- `generate.mutate(undefined, { onSuccess: ... })` 成功回调里（已有回调处）：`setLastElapsed(Math.round((Date.now() - (genStart ?? Date.now())) / 1000)); setGenStart(null);`（若 onSuccess 闭包拿不到最新 genStart，改用 ref 或在 mutate 前记录局部变量传入）。
- 生成中行（原"生成中，约需十几秒…"）替换为：

```tsx
        <p className="mt-3 text-xs text-muted-foreground">
          生成中 <ElapsedTimer since={genStart ?? Date.now()} />…
        </p>
```

- 新文章视图顶部（文章标题上方或下方，选现有布局自然位置）加：

```tsx
      {lastElapsed !== null && (
        <p className="text-xs text-muted-foreground/60">生成耗时 {lastElapsed}s</p>
      )}
```

3c. `StartSessionDialog.tsx` pending 分支"首次生成约需一分钟"行下加：

```tsx
            <p className="mt-1 text-xs text-muted-foreground">
              已等待 <ElapsedTimer since={startedAt} />，首次生成约需一分钟
            </p>
```

（原"首次生成约需一分钟，请保持页面打开"合并进此行。计时起点采用**组件挂载时刻**：`const [startedAt] = useState(() => Date.now());`——为此 IdleToday 必须从"常驻渲染（组件内部 return null）"改为**条件挂载**：

```tsx
      {(start.isPending || start.isError) && (
        <StartSessionDialog
          pending={start.isPending}
          errorMessage={...}
          onRetry={() => start.mutate()}
          onDismiss={() => start.reset()}
        />
      )}
```

否则 useState 初值取到页面加载时刻会失真。StartSessionDialog 内部的 `if (!pending && !errorMessage) return null;` 保留（双保险）。）

- [ ] **Step 4: 跑单测确认 GREEN + 全量 + e2e**

Run: `pnpm --filter @el/web run test` → 全过。
Run: `pnpm --filter @el/web run typecheck` → 无错误。
Run: `E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "Read"` → 全过。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/elapsed-timer.tsx apps/web/src/features/read/ReadPage.tsx apps/web/src/features/today/components/StartSessionDialog.tsx apps/web/tests
git commit -m "feat(web): Read/开始生成正计时与完成耗时显示

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 3: 全量验证 + 部署 + 真机复验（编排者执行）

- [ ] Step 1: `pnpm --filter @el/api run test` 与 `pnpm --filter @el/web run test` 全过；双侧 typecheck。
- [ ] Step 2: 全量 e2e `E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test`。
- [ ] Step 3: 部署 deploy.sh（CI=true NODE_OPTIONS 前缀）+ 双入口验证 + 推送。
- [ ] Step 4: 服务器侧真机等价复验：用 /tmp/repro-read3.mts 同法（真实 buildReadSelection）跑一次 completeStructured——focus 现在为 3——断言成功且记录耗时；结果告知用户真机重试。
