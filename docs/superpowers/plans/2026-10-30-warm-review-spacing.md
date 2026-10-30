# 暖纸配色与复习卡片间距 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复暖纸配色，保留大尺寸，收小圆角，并给活动复习卡与底部 Tab 留 20px 间距。

**Architecture:** 沿用 `globals.css` 作为视觉和布局令牌唯一来源。同步移动端 chrome 的实际几何与 Today 高度公式，保留键盘与桌面行为。PWA 主题跟随暖纸背景。

**Tech Stack:** React、Vite、Tailwind CSS、Vitest、Playwright，沿用现有依赖。

**Spec:** `docs/superpowers/specs/2026-10-30-warm-review-spacing-design.md`

## Global Constraints

- 全局色卡恢复 `ac44644^` 的暖纸、暖白、暖黑、灰褐与陶土语义色；半透明顶栏/导航及 PWA 主题、启动背景与之同步。
- 保留当前大词条字号、按钮高度、44px 最小触控与移动/桌面布局。
- 基础圆角由 18px 收为 12px，沿用既有派生关系，大卡片圆角为 16px。
- 手机活动复习卡片底边与底部导航顶边留 20px 页面背景，与现有左右 20px 留白形成一致节奏。通过扣减卡片可用高度实现，保留内容内部滚动和操作区可见。
- 不修改业务状态、接口、Prompt 或数据库。不增加功能、依赖和第二套主题。

## Review Focus

- 窄/短手机屏幕：卡片、进度、停靠按钮和 Tab 不互相遮挡，无横向溢出。
- 长词条/原句/释义与揭示答案：正文可滚动，主操作保持可达。
- 模拟底部安全区：导航高度与卡片间距准确，不重复扣减安全区。
- 键盘预置/打开/关闭：现有 viewport 分支全部一致，键盘跟随和恢复无回归。
- 桌面无底部 Tab：不扣除新增的手机导航留白；PWA 与页面色卡一致。

## Task 1: 视觉与高度修正

**Files:**
- Modify: `docs/PRODUCT_DESIGN.md`, `docs/ARCHITECTURE.md`, `docs/phases/phase-14-native-learning.md`
- Modify: `apps/web/src/styles/globals.css`, `apps/web/src/app/shell.tsx`（仅需要时）、`apps/web/index.html`, `apps/web/vite.config.ts`
- Test: `apps/web/e2e/today-layout.spec.ts`（或沿用合适的现有 E2E 文件）、必要的现有布局/键盘测试。

**Interfaces:**
- Consumes: AppShell 固定顶栏和 Tab、`h-today-viewport`、`--header-block`、`--nav-block`、keyboard viewport CSS 变量。
- Produces: 单一全局暖纸色卡、12px 基础圆角、手机活动卡 20px Tab 留白；有独立临时数据库的浏览器回归证据。

- [x] Step 1: 阅读 AGENTS.md 要求的七份项目文档及阶段留档，先同步产品规范与阶段决策，再修改代码。
- [x] Step 2: 为卡片与导航约 20px 间距、无顶栏遮挡、长内容停靠操作可达、模拟安全区与桌面布局编写真实浏览器断言；沿用项目现有认证/隔离数据库与 mock AI。运行并保存当前版本失败证据。
- [x] Step 3: 以最小改动恢复旧色卡及 PWA 元数据，基础圆角收为 12px；同步 chrome 几何和所有 Today 常态/keyboard priming 高度分支，只在手机 Tab 可见时扣减新增留白。保留当前字号、按钮与内部滚动。
- [x] Step 4: 重跑针对性布局和键盘测试、截图测量，确认通过。测试因环境失败时先解决可解决的依赖/运行环境，不把环境失败记成断言成功。
- [x] Step 5: 更新阶段日志及实际验证结论，运行相关格式检查，分别提交文档与实现；报告完整命令、结果、提交与未验证项。

## 集成验证与审查

- [x] 完整 E2E 暴露旧进度文字、反馈按钮及自由造句历史断言时，先在未改的 `1cfb29c` 基线复现；若确认是既有失配，仅同步 `production.spec.ts` 与 `today.spec.ts` 到现行拼词契约，保留真实作答、分项结果、历史、只读记录、进度与首屏时限断言，消除跨用例顺序依赖。不修改产品行为。
- 独立 reviewer 已完成任务审查；最终全部差异以合入前保存的独立终审报告为准。
- [x] 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm e2e` 和 `pnpm build`；UI 由 visual_tester 检查实际画面。
- [x] 按 neat-freak 核对本次文档、代码和阶段留档，保留浏览器证据。
- 最终集成要求：完整分支独立终审，以审查通过的 SHA 走 worktree-flow squash 合入与推送，归档并清理本任务资源。集成结果以 Git 主干和 `archive/warm-review-spacing` 引用为准。不得部署或重启生产。
