# 按钮全局色彩体系与应用内色卡页 — 设计 Spec

日期：2026-10-02。状态：已与用户确认（对话内逐节过审）。

## 背景与问题

- 中性按钮（原 `outline`）为透明底 + 浅米描边（#e5e0d6），在米色背景上几乎与背景融合，没有"按键"实体感。
- 语义色散落业务代码：否定键暖红是三处复制的 className 字符串（RecallCard ×2、PracticeView ×1），无全局管理。
- 2026-10-02 用户决策：中性按钮改浅暖色填充；色彩体系代码集中 + 应用内色卡页；全量 sweep。

## 目标

1. Button 组件成为按钮颜色的唯一出处：语义变体 + 悬停/禁用态集中定义，业务代码不再写颜色类。
2. 应用内色卡页 `/tokens`：真组件真 token 渲染全局设计基元，改样式自动同步。
3. 全部 21 文件 65+ 按钮用点归位语义变体，消除混合状态。

## 非目标

- 不引入 Storybook 等外部基建；不做主题切换/暗色模式。
- 业务卡（RecallCard、TaskCard、ChoiceQuestionCard 等带学习逻辑的组件）不进色卡页。
- 不改 token 的既有色值（#a8541f / #b3402a / #f5e7dc / #4a7c59 / #8f7514 等保持不变）。

## 1. 按钮语义体系（`apps/web/src/components/ui/button.tsx` cva）

| 变体 | 样式（Tailwind 类，集中于此） | 语义 | 现有实例 |
| --- | --- | --- | --- |
| `primary`（=现 default，保留 default 为别名） | `bg-accent text-accent-foreground hover:opacity-90` | 肯定/主操作 | 想起来了、提交、下一题、保存 |
| `neutral`（新增，取代 outline 的中性角色） | `border border-input bg-accent-soft text-foreground hover:brightness-95` | 中性/次要操作 | 显示答案、取消、关闭 |
| `negative`（新增） | `border border-destructive/50 bg-destructive/10 text-destructive hover:border-destructive hover:bg-destructive/20 hover:text-destructive` | 学习流否定自评 | 想错了、没想起来 |
| `destructive`（保留，升级为实心） | `bg-destructive text-white hover:opacity-90` | 不可逆危险操作确认 | 恢复备份确认、归档 |
| `ghost` | `bg-muted text-foreground hover:brightness-95` | 弱操作/工具性 | 给我提示、刷新、图标按钮 |

> 2026-10-02 用户真机反馈修订：negative 与 ghost 静止态不得透明融入背景——negative 由 `bg-transparent` 改静止浅红填充 `bg-destructive/10`（悬停 /20）；ghost 由纯悬停态改静止灰浅填充 `bg-muted`。原则：任何变体静止态都必须与所在背景有可辨识的填充差异。

- 禁用态统一 `disabled:opacity-50`（已有）；焦点环 `focus-visible:ring-accent/40` 不变。
- **规则**：业务代码的 Button className 只允许布局/尺寸类（`flex-1`、`hidden md:inline-flex`、宽高覆盖等），不允许颜色类（bg-/text-/border- 色彩、hover 色彩）。sweep 中违反者归位到变体。
- 现有 29 处 `outline` 用点逐一判断归属：非肯定非否定的次要操作 → `neutral`；属否定自评 → `negative`。

## 2. 色卡页 `/tokens`

- 路由：`/tokens`，不进底部导航/侧栏，直接 URL 访问；登录后可见（在 AppShell 内，保持与现有页面一致的鉴权）。
- 页面分节（每节一个标题，供测试锚定）：
  1. **色板**：全部 globals.css token（背景/卡片/前景/muted/border/input/accent/accent-soft/destructive/success/warning/diff-delete/diff-insert），每项 = 色块 + 变量名 + hex 文本。
  2. **按钮矩阵**：五个变体 × [正常, 禁用]，附一行文字说明语义与典型用例。
  3. **判语语义色**：通过（text-success）/ 基础通过（text-warning）/ 未通过（text-destructive）文本样例。
  4. **字号层级**：text-xs / text-sm / text-base / text-lg 实例行。
  5. **diff 色**：CorrectionDiff 的 delete（#b3402a）/insert（#3e7d52）色样。
- 实现为一个普通 React 页面组件，直接渲染真 Button 与样式类；色板 hex 值运行时用 `getComputedStyle` 从文档根读取 CSS 变量的实际应用值，不手抄第二份数据。
- 测试：路由可达 + 五节标题存在 + 按钮矩阵渲染出五个变体类名（冒烟级）。

## 3. 全量 sweep

- 范围：21 个使用 Button 的文件全部用点（29 outline + 34 ghost + 2 destructive + 其余 default）逐点归类到语义变体。
- 收敛散写：RecallCard（2 处）与 PracticeView（1 处）的内联红色 className → `variant="negative"`。
- 同步更新测试断言：现断言 `text-destructive` 内联类的用例改为断言 negative 变体类名；其余按需微调，不删断言。

## 4. 测试与门禁

- 单测：按钮变体类名断言、/tokens 页冒烟、既有全套回归。
- 门禁：`pnpm lint`、`pnpm typecheck`、web 全量 vitest、prettier、today E2E（`E2E_API_PORT=5175 --workers=1`）。
- 完成后按惯例提交 → 推送 → 部署 → 冒烟（health/web 200）。

## 5. 风险与对策

- **视觉回归风险**：neutral 由透明底变浅暖填充，全部页面按钮观感变化明显——属预期改版；E2E 不做像素断言，靠人工真机验收（用户手机上 /tokens + Today/Library 走查）。
- **归类误判**：outline→negative 的判断以"学习流自评否定"为准绳，其余一律 neutral；sweep 中逐点人工归类并记录。
- **漂移**：色卡页读真 token、真组件，改样式自动同步；唯一缺口是"新组件未登记"，接受（单用户应用，成本收益不匹配）。
