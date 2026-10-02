# 按钮全局色彩体系与应用内色卡页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按钮颜色收敛为 Button 组件的五个语义变体（唯一出处），新增应用内色卡页 `/tokens` 真渲染全局设计基元，全量迁移 29 处 `outline` 用点并删除该变体。

**Architecture:** `apps/web/src/components/ui/button.tsx` 的 cva 新增 `neutral`/`negative` 变体、`destructive` 升级实心、`primary`（含 `default` 别名）；新增 `apps/web/src/features/tokens/TokensPage.tsx` 于 AppShell 鉴权路由组内；sweep 全部 `variant="outline"` → `variant="neutral"` 后删除 outline 变体，TypeScript 编译期兜底无遗漏。

**Tech Stack:** React + Vite + TypeScript, Tailwind v4（CSS 变量 token 于 `apps/web/src/styles/globals.css`），cva + tailwind-merge，Vitest + Testing Library，Playwright。

**Spec:** `docs/superpowers/specs/2026-10-02-button-color-system-design.md`（已过审）。

## Global Constraints

- 不改任何 token 既有色值：`--accent:#a8541f`、`--accent-soft:#f5e7dc`、`--input:#d9d3c7`、`--destructive:#b3402a`、`--success:#4a7c59`、`--warning:#8f7514`、`--diff-insert:#3e7d52`、`--background:#faf9f6`、`--card:#ffffff`。
- 变体类串（唯一出处，业务代码禁止颜色类 className；布局/尺寸类如 `flex-1`、`hidden md:inline-flex` 允许）：
  - `primary` 与 `default`：`bg-accent text-accent-foreground hover:opacity-90`
  - `neutral`：`border border-input bg-accent-soft text-foreground hover:brightness-95`
  - `negative`：`border border-destructive/50 bg-transparent text-destructive hover:border-destructive hover:bg-destructive/10 hover:text-destructive`
  - `destructive`：`bg-destructive text-white hover:opacity-90`
  - `ghost`：`hover:bg-muted`（不变）
- 禁用态 `disabled:opacity-50`、焦点环 `focus-visible:ring-accent/40` 维持现状。
- 色卡页 hex 用 `getComputedStyle(document.documentElement).getPropertyValue(...)` 运行时读取，不得手抄第二份。
- 例外：`choice-question-card.tsx` 选项按钮的判分标记（`border-success text-success` / `border-destructive text-destructive`）保留，语义为答对/答错反馈而非按钮主题色。
- 测试命令一律串行（内存受限 1.9G）；Playwright 用 `E2E_API_PORT=5175 ... --workers=1`；不加锁并行跑命令。
- 每个 Task 完成即 `git commit`（含 HAPI 尾注）；**部署只在 Task 4 末尾执行一次**（改完即部署惯例，但不部署中间态）。
- 不触碰 `.claude/skills/import-english/SKILL.md`（用户自有未提交改动）。

## File Map / Interfaces

| 单元 | 文件 | 职责 |
| --- | --- | --- |
| Button 变体 | `apps/web/src/components/ui/button.tsx` | 五语义变体 +（过渡期保留）outline |
| 变体测试 | `apps/web/tests/button.test.tsx`（新建） | 断言各变体类串 |
| 色卡页 | `apps/web/src/features/tokens/TokensPage.tsx`（新建）、`apps/web/src/App.tsx` | 五节展示 + `/tokens` 路由 |
| 色卡测试 | `apps/web/tests/tokens-page.test.tsx`（新建） | 路由可达 + 五节标题 + 变体类名冒烟 |
| 散写收敛 | `apps/web/src/features/today/components/RecallCard.tsx:213,231`、`apps/web/src/features/library/PracticeView.tsx:101` | 内联红色类 → `variant="negative"` |
| 全量 sweep | 其余全部 `variant="outline"` 文件（见 Task 3 表） | outline → neutral，删 outline |
| 断言适配 | `apps/web/tests/today-recall.test.tsx`、`apps/web/tests/library-production.test.tsx` | 内联类断言 → 变体类断言 |
| 文档指针 | `docs/PRODUCT_DESIGN.md` §5.1 | 一句话指向 `/tokens` 为按钮颜色权威出处 |

**Interfaces（跨任务依赖）:** Button 的 cva `variant` 键集合在 Task 1 后为 `default | primary | neutral | negative | ghost | destructive | outline`（outline 为旧样式，Task 3 删除）；TokensPage 为默认导出无关的命名导出 `export function TokensPage()`，不接收 props。

---

### Task 1: Button 语义变体与三处散写收敛

**Files:**
- Modify: `apps/web/src/components/ui/button.tsx`
- Modify: `apps/web/src/features/today/components/RecallCard.tsx:213-218, 231-236`
- Modify: `apps/web/src/features/library/PracticeView.tsx:101-107`
- Test: `apps/web/tests/button.test.tsx`（新建）

**Interfaces:**
- Produces: cva 变体键 `primary`/`neutral`/`negative` 及上述 Global Constraints 中的类串；`destructive` 变为实心；`outline` 暂保留旧样式（Task 3 删）。

- [ ] **Step 1: 写失败测试**

创建 `apps/web/tests/button.test.tsx`：

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../src/components/ui/button';

afterEach(cleanup);

/** 变体类串是全局按钮颜色唯一出处（spec 2026-10-02），锁死防漂移 */
describe('Button 语义变体类名', () => {
  it.each([
    ['primary', 'bg-accent text-accent-foreground'],
    ['default', 'bg-accent text-accent-foreground'],
    ['neutral', 'border-input bg-accent-soft text-foreground'],
    ['negative', 'border-destructive/50 bg-transparent text-destructive'],
    ['destructive', 'bg-destructive text-white'],
    ['ghost', 'hover:bg-muted'],
  ] as const)('%s → %s', (variant, expected) => {
    render(<Button variant={variant}>按钮</Button>);
    expect(screen.getByRole('button', { name: '按钮' }).className).toContain(expected);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @el/web exec vitest run tests/button.test.tsx`
Expected: FAIL（neutral/negative/destructive 实心类串不匹配——neutral/negative 不存在致 variant 落空、destructive 仍是文字红样式）。

- [ ] **Step 3: 最小实现**

`apps/web/src/components/ui/button.tsx` 的 `variants.variant` 改为：

```tsx
      variant: {
        default: 'bg-accent text-accent-foreground hover:opacity-90',
        primary: 'bg-accent text-accent-foreground hover:opacity-90',
        neutral: 'border border-input bg-accent-soft text-foreground hover:brightness-95',
        negative:
          'border border-destructive/50 bg-transparent text-destructive hover:border-destructive hover:bg-destructive/10 hover:text-destructive',
        ghost: 'hover:bg-muted',
        destructive: 'bg-destructive text-white hover:opacity-90',
        // 旧中性样式，全量 sweep 后在 Task 3 删除
        outline: 'border border-border bg-transparent hover:bg-muted',
      },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @el/web exec vitest run tests/button.test.tsx`
Expected: PASS 6/6。

- [ ] **Step 5: 三处散写收敛为 negative**

`RecallCard.tsx` 两处（揭示前「没想起来」与揭示后「想错了」）形如：

```tsx
            <Button
              variant="outline"
              className="flex-1 border-destructive/50 text-destructive hover:border-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={answer.isPending}
              onClick={() => submit({ recall: 'forgot' })}
            >
```

改为：

```tsx
            <Button
              variant="negative"
              className="flex-1"
              disabled={answer.isPending}
              onClick={() => submit({ recall: 'forgot' })}
            >
```

（「想错了」一处同样改法，保留 `{ autoAdvance: true }` 参数原样。）`PracticeView.tsx:101` 的「没想起来」同样：`variant="negative"`、className 删色类只留 `flex-1`、其余 props 不动。

- [ ] **Step 6: 既有断言仍绿**

Run: `pnpm --filter @el/web exec vitest run tests/today-recall.test.tsx tests/library-production.test.tsx`
Expected: PASS（断言的 `text-destructive` 由 negative 变体类串提供，不需改动即可通过）。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/components/ui/button.tsx apps/web/src/features/today/components/RecallCard.tsx apps/web/src/features/library/PracticeView.tsx apps/web/tests/button.test.tsx
git commit -m "feat(web): Button 五语义变体（primary/neutral/negative/destructive/ghost），散写否定键收敛 negative"
```

### Task 2: /tokens 色卡页

**Files:**
- Create: `apps/web/src/features/tokens/TokensPage.tsx`
- Modify: `apps/web/src/App.tsx`（AppShell 路由组内加一行）
- Test: `apps/web/tests/tokens-page.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 的 Button 变体；globals.css 的 CSS 变量（`--background` 等，见下方 TOKENS 数组）。
- Produces: `export function TokensPage(): ReactNode`；路由 `/tokens`。

- [ ] **Step 1: 写失败测试**

创建 `apps/web/tests/tokens-page.test.tsx`：

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { TokensPage } from '../src/features/tokens/TokensPage';

afterEach(cleanup);

function renderAtTokens() {
  return render(
    <MemoryRouter initialEntries={['/tokens']}>
      <Routes>
        <Route path="/tokens" element={<TokensPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('/tokens 色卡页（全局设计基元权威展示）', () => {
  it('五节标题齐全', async () => {
    renderAtTokens();
    for (const h of ['色板', '按钮矩阵', '判语语义色', '字号层级', 'Diff 色']) {
      expect(await screen.findByRole('heading', { name: h })).toBeVisible();
    }
  });

  it('按钮矩阵渲染五个变体与禁用态', async () => {
    renderAtTokens();
    for (const label of ['primary', 'neutral', 'negative', 'destructive', 'ghost']) {
      expect(screen.getByRole('button', { name: label, exact: false })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /禁用/ })).toBeDisabled();
  });

  it('色板每项含变量名', async () => {
    renderAtTokens();
    expect(await screen.findByText('--accent', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('--destructive', { exact: false })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @el/web exec vitest run tests/tokens-page.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现页面**

创建 `apps/web/src/features/tokens/TokensPage.tsx`：

```tsx
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/button';

/** 色板条目：cssVar 为 globals.css :root 变量名 */
const TOKENS: { name: string; cssVar: string }[] = [
  { name: '背景 background', cssVar: '--background' },
  { name: '卡片 card', cssVar: '--card' },
  { name: '前景 foreground', cssVar: '--foreground' },
  { name: '柔和底 muted', cssVar: '--muted' },
  { name: '柔和前景 muted-foreground', cssVar: '--muted-foreground' },
  { name: '品牌暖橙 accent', cssVar: '--accent' },
  { name: '浅暖填充 accent-soft', cssVar: '--accent-soft' },
  { name: '描边 border', cssVar: '--border' },
  { name: '输入描边 input', cssVar: '--input' },
  { name: '暖红 destructive', cssVar: '--destructive' },
  { name: '通过绿 success', cssVar: '--success' },
  { name: '基础通过金 warning', cssVar: '--warning' },
  { name: 'Diff 删除 diff-delete', cssVar: '--diff-delete' },
  { name: 'Diff 插入 diff-insert', cssVar: '--diff-insert' },
];

/** /tokens：全局设计基元色卡页（不入导航）；色值运行时读 CSS 变量，零第二份数据 */
export function TokensPage(): ReactNode {
  const [hexOf, setHexOf] = useState<Record<string, string>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setHexOf(Object.fromEntries(TOKENS.map((t) => [t.cssVar, style.getPropertyValue(t.cssVar).trim()])));
  }, []);

  return (
    <div className="space-y-8 p-6">
      <h2 className="text-lg font-semibold">色板</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {TOKENS.map((t) => (
          <div key={t.cssVar} className="space-y-1">
            <div
              className="h-10 rounded-lg border border-border"
              style={{ backgroundColor: `var(${t.cssVar})` }}
              aria-hidden
            />
            <p className="text-xs text-muted-foreground">
              {t.name} · <code>{t.cssVar}</code> {hexOf[t.cssVar] && `· ${hexOf[t.cssVar]}`}
            </p>
          </div>
        ))}
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">按钮矩阵</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">primary</Button>
          <Button variant="neutral">neutral</Button>
          <Button variant="negative">negative</Button>
          <Button variant="destructive">destructive</Button>
          <Button variant="ghost">ghost</Button>
          <Button variant="neutral" disabled>
            禁用
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          primary=肯定主操作；neutral=中性次要；negative=学习流否定自评；destructive=不可逆危险确认；ghost=弱操作
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">判语语义色</h2>
        <p className="text-sm text-success">通过 · 想起来了</p>
        <p className="text-sm text-warning">基础通过 · 提示后想起</p>
        <p className="text-sm text-destructive">未通过 · 没想起来 / 想错了</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">字号层级</h2>
        <p className="text-lg text-foreground">text-lg 词行/标题</p>
        <p className="text-base text-foreground">text-base 释义</p>
        <p className="text-sm text-foreground">text-sm 正文</p>
        <p className="text-xs text-muted-foreground">text-xs 辅助说明</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Diff 色</h2>
        <p>
          <span className="text-diff-delete">删除：原句错误片段</span>
          <span className="ml-2 text-diff-insert">插入：修正后片段</span>
        </p>
      </section>
    </div>
  );
}
```

`apps/web/src/App.tsx` 在 `<Route path="/read" .../>` 之后加（import 区补 `TokensPage`）：

```tsx
          <Route path="/tokens" element={<TokensPage />} />
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @el/web exec vitest run tests/tokens-page.test.tsx`
Expected: PASS 3/3（jsdom 取不到 CSS 变量值时 hex 文本为空，断言只查变量名，不查 hex——真机看效果）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/features/tokens/TokensPage.tsx apps/web/src/App.tsx apps/web/tests/tokens-page.test.tsx
git commit -m "feat(web): /tokens 应用内色卡页——色板/按钮矩阵/判语色/字号/Diff 真渲染"
```

### Task 3: outline 全量迁移并删除该变体

**Files:**
- Modify: 下表 8 个文件的 `variant="outline"`（RecallCard/PracticeView 的三处已在 Task 1 改为 negative，不在本表）
- Modify: `apps/web/src/components/ui/button.tsx`（删 outline）、`apps/web/tests/button.test.tsx`（无需加——outline 删除后 tsc 兜底）

**Interfaces:**
- Consumes: Task 1 的 `neutral` 变体。
- Produces: cva 变体键最终集合 `default | primary | neutral | negative | ghost | destructive`。

迁移规则：**全部 → `variant="neutral"`**，只改 variant 值，其他 props/className 一律不动。唯一特殊点：`choice-question-card.tsx:148` 选项按钮转 neutral 后**保留**其 `cn(...)` 判分标记（Global Constraints 已列例外）。

| 文件:行 | 说明 |
| --- | --- |
| `apps/web/src/components/choice-question-card.tsx:148` | 选项按钮（保留判分标记） |
| `apps/web/src/features/settings/components/BackupSection.tsx:152` | 导出 |
| `apps/web/src/features/read/ReadPage.tsx:81,137` | 刷新 / 次要操作 |
| `apps/web/src/features/read/components/ReadHistoryView.tsx:64,87,98` | 刷新 / 次要操作 |
| `apps/web/src/features/today/TodayPage.tsx:53` | 刷新 |
| `apps/web/src/features/today/components/TaskCard.tsx:41` | 稍后再做 |
| `apps/web/src/features/today/components/RecallCard.tsx:209` | 显示答案 |
| `apps/web/src/features/library/ImportWizard.tsx:202` | 应用建议 |
| `apps/web/src/features/library/LibraryDetailPage.tsx:291,576,579,584,594,604,622,636` | 编辑/练一下/对话框次要操作（归档主按钮 613 已是 destructive，不动） |
| `apps/web/src/features/library/LibraryPage.tsx:50,90,100,158,169` | 工具/次要操作 |
| `apps/web/src/features/library/PracticeView.tsx:187,201` | 重练 / 返回详情 |

- [ ] **Step 1: 逐点迁移**

对上表逐处 `variant="outline"` → `variant="neutral"`（用编辑器逐处改；不使用全局 sed，避免误伤字符串/注释）。

- [ ] **Step 2: 删除 outline 变体**

`button.tsx` 删掉 `outline: 'border border-border bg-transparent hover:bg-muted',` 行及其注释；`button.test.tsx` 不含 outline 用例，无需改。

- [ ] **Step 3: 编译与全量回归**

Run: `pnpm typecheck && pnpm --filter @el/web exec vitest run`
Expected: typecheck 0 错（残留 outline 用法在此暴露）；全量 PASS。

- [ ] **Step 4: E2E 冒烟**

Run: `E2E_API_PORT=5175 NODE_OPTIONS=--max-old-space-size=1024 pnpm --filter @el/web exec playwright test --workers=1`
Expected: 全部 PASS（按钮无 role/name 断言变化，视觉变化不影响）。

- [ ] **Step 5: 提交**

```bash
git add -u
git commit -m "refactor(web): outline 全量迁移 neutral 并删除旧变体——按钮颜色唯一出处收敛完成"
```

### Task 4: 文档指针、全门禁与部署

**Files:**
- Modify: `docs/PRODUCT_DESIGN.md`（§5.1 按钮相关段落后补一行）

- [ ] **Step 1: 文档指针**

在 `docs/PRODUCT_DESIGN.md` §5.1（沉浸式卡/交互规范一节）段末追加：

```markdown
按钮颜色全局唯一出处是 Button 组件语义变体（primary/neutral/negative/destructive/ghost）；应用内 `/tokens` 页真渲染色板与按钮矩阵，为权威色卡（2026-10-02 起）。
```

- [ ] **Step 2: 全门禁**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm exec prettier --check docs/PRODUCT_DESIGN.md apps/web/src/components/ui/button.tsx apps/web/src/features/tokens/TokensPage.tsx apps/web/tests/button.test.tsx apps/web/tests/tokens-page.test.tsx && git diff --check`
Expected: 全部 exit 0。

- [ ] **Step 3: 提交并部署（一次性）**

```bash
git add docs/PRODUCT_DESIGN.md
git commit -m "docs: PRODUCT §5.1 指向 /tokens 为按钮颜色权威色卡"
git push
NODE_OPTIONS=--max-old-space-size=1024 ./deploy/deploy.sh
```

- [ ] **Step 4: 冒烟**

Run: `sleep 3 && systemctl is-active english-learning-api && curl -fsS http://127.0.0.1:5174/api/health && curl -fsS -o /dev/null -w "web %{http_code}\n" http://127.0.0.1:8080/ && curl -fsS -o /dev/null -w "tokens %{http_code}\n" http://127.0.0.1:8080/tokens`
Expected: active / `{"status":"ok"}` / web 200 / tokens 200。

## Self-Review

- Spec 覆盖：五变体表（Task 1）、/tokens 五节（Task 2）、全量 sweep+删 outline（Task 3）、判分标记例外（Task 3 表首行）、断言适配（Task 1 Step 6 既有断言天然兼容 + Task 3 全量回归）、门禁与部署（Task 4）。中性浅暖填充/危险实心/否定描边均与 spec 一致。
- 占位符扫描：无 TBD/“适当处理”；迁移表给全 file:line 与规则。
- 类型一致性：变体键名与类串在 Global Constraints、Task 1、Task 2/3 引用处一致；TokensPage 命名导出与测试 import 一致。
