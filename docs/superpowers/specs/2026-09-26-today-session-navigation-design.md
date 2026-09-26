# Today 会话导航改版设计

日期：2026-09-26
状态：已与用户确认（逐节通过）
范围：Today 会话页导航/进度/列表/动画/回看显示，1 个新端点 + 契约微调 + 前端重构。

## 背景与动机

用户四条反馈：

1. 任务列表弹层应显示会话全部任务单词，而不是只有当前题。
2. 滑动回看时顶部进度条与数字不变化；希望滑动像 Anki 一样有跟手翻页动画。
3. 回看部分题卡只见例句与选项、看不到考的单词。
4. 进度条应按"该题做过/没做过"着色（可间隔），并允许跳着做题。

现状根因（探索结论）：

- `GET /api/today` 已返回 `sessionTasks` 概要但前端未用；前端用本地 `history` 数组做导航轴，刷新即丢、无法覆盖未完成任务。
- `answerTodayTask` 本就允许作答会话内任意未完成任务，只缺"按会话取全部题面"的读端点。
- 进度条数字是服务端"已完成/总数"语义，滑动回看时按设计不变，与用户"位置指示"预期不符。
- 选择题卡中 target 仅用于上下文高亮，从不单独展示，回看非 learn 卡时无单词行。

## 已确认的决策

| 决策点 | 用户选择 |
| --- | --- |
| 进度语义 | 数字=当前位置（第 X / N，随滑动变）+ 分段按做过/没做着色、当前位置段加高 |
| 跳着做 | 列表全部可点：已完成→回看；未完成→跳去做并可作答 |
| 动画 | 跟手 3D 翻页（无新依赖，纯 CSS transform + 触摸跟踪） |
| 架构 | sessionTasks 为主轴重构导航（方案 A） |
| 加载策略 | 批量端点一次拉全，滑动 0 请求 |

## 1. 数据契约

### 新增 `GET /api/today/tasks`

- 响应：`{ tasks: SessionTaskEntry[] }`，`SessionTaskEntry = { task: TodayTaskView, result: AnswerResponse | null }`。
- 会话内全部任务（**含已撤销**），按 `sortKey` 升序。
- `task.completedAt != null` → `result` 为首次结算摘要（复用现有 `replayAnswer` 逻辑，抽公共函数，不重复写）；未完成/已撤销 → `null`。
- 无活跃会话 → 409 CONFLICT（与 answer 的"会话已完成"语义一致）。
- 只读幂等；认证同现有 today 路由。

### 契约清理

- **移除 `TodayActiveResponse.sessionTasks`**（前端从未使用，职责被批量端点取代）；同步 `packages/shared/src/schemas/api/today.ts` 与受影响测试。
- `SessionTaskSummary` 类型随之删除。

### 刷新节奏

- 前端在 `todayKeys` 增加批量 key；作答/稍后/坏题/反馈后的现有 `invalidateQueries({ queryKey: todayKeys.all })` 自动覆盖批量端点。
- 补强题插入、"稍后"重排在 invalidate 后自动同步；SQLite 本地查询 <10ms，全量 payload 约 100-200KB，可接受。

## 2. 进度条与数字

- 数字：`第 X / N`——X 为当前展示卡在会话序列中的 1-based 位置，滑动实时更新。
- 分段：每题一段；完成 → `bg-accent`，未完成/已撤销 → `bg-muted`；允许间隔着色（跳着做后 1、3 有色 2、4 无色）。
- 当前位置段加高（h-1.5，其余 h-1）以区分位置与完成状态两个维度。
- 仅使用现有设计 token，符合 Quiet UI（PRODUCT §UI 约束"不使用五颜六色进度条"）。

## 3. 任务列表弹层

- 数据源：批量端点结果。
- 每行：单词 + 题型小标签（learn/理解/填空/表达）+ 状态（✓ 对 / ✗ 错 / 已撤销 / 未做）。
- 全部可点：已完成/已撤销 → 回看（readOnly）；未完成 → 跳去做（可作答）。
- 当前任务行高亮并标"当前"。

## 4. 导航模型重构（ActiveSession）

- 删除本地 `history` 数组导航轴与 `answeredTaskIds` ref；改为：
  - `taskViews: SessionTaskEntry[]`（批量端点数据，TanStack Query 缓存）；
  - `cursor: number | null`——`null` 表示当前题（服务端 currentTask 对应条目），非 null 表示回看/跳做索引。
- 滑动语义：
  - 左滑：`cursor` 前移一位，最前回弹；
  - 右滑：`cursor` 后移，越过最后一项回到当前题（`null`）；
  - **当前题上的右滑保持现有行为**：已答（frozen）→ advance；未答 → `later` 稍后再做。
- 跳做未完成任务：显示完整题卡、可作答（后端已支持）；答完展示反馈后 advance 回到服务端下一题，`cursor` 归 `null`。
- 保留行为：答对 4s 自动下一题（仅当前题、非回看/跳做）、坏题撤销、蒙的/太简单反馈、Learn 卡两阶段交互。
- 会话完成边界：最后一题答完状态翻转为 completed 时仍先展示反馈，advance 后进完成页（现有逻辑不变）。

## 5. 跟手 3D 翻页动画

- 无新依赖：`touchstart/touchmove/touchend` + CSS transform。
- `touchmove`：水平主导（`|dx| > |dy| * 1.5`）时卡片容器 `transform: translateX(dx) rotateY(dx * 0.06deg)`，父容器 `perspective`；不 preventDefault，不影响垂直滚动与按钮点击。
- `touchend`：`|dx| > 60` 且水平主导 → 卡片沿滑动方向滑出（transition ~250ms）→ 切换内容 → 新卡从对侧滑入；否则回弹（~200ms）。
- 当前题未作答右滑（稍后再做）复用同一滑出动画。
- 桌面/无触摸：进度条弹层跳转 + 键盘 ←/→ 同滑动语义。
- `prefers-reduced-motion`：退化为瞬时切换。
- iOS 边缘滑动导航禁用逻辑（166ffc0）保持不变。

## 6. 回看显示单词

- TaskCard 顶部增加单词行（target + IPA，仅 word 显示 IPA）：**`result != null` 或 `readOnly` 时**所有题型统一显示。
- 未作答时不显示（避免剧透填空/理解题答案）；learn 卡维持现有词行不变。

## 7. 后端实现要点

- `apps/api/src/modules/today/service.ts`：
  - 从 `replayAnswer` 抽出"已完成任务 → 首次结果摘要"公共函数，`answerTodayTask` 幂等分支与批量端点共用；
  - 批量端点实现：查当日活跃 session → 全部任务（含 canceled）按 sortKey → `taskToView` + 结果摘要。
- 路由注册 `GET /api/today/tasks`。

## 8. 测试（TDD，AGENTS §9）

- API 集成（fastify.inject + 临时 SQLite）：
  - 无活跃会话 → 409；
  - 活跃会话：顺序正确、已完成含 result、未完成为 null、包含已撤销任务；
  - 重复调用幂等；答错插入补强题后任务数增长。
- Web 单测（vitest + testing-library）：
  - 进度条间隔着色 + 当前位置段加高；数字随 cursor 变化；
  - 弹层全量渲染 + 跳转（完成→回看、未完成→可作答）；
  - 词行显隐（已答/回看显示、未答不显示）；
  - 右滑当前未答题 → later 调用（回归）；
  - reduced-motion 降级。
- E2E（Playwright，1 条）：作答 → 左滑回看（词行可见、数字变化）→ 列表跳做未完成题 → 进度条间隔着色。注意服务器内存，限制并发。

## 9. 文档同步（AGENTS §11）

1. `PRODUCT_DESIGN.md` §7：Today 会话导航规则（当前位置数字、按题完成着色、列表全量可点与跳做、回看词行、稍后语义边界）。
2. `TECHNICAL_DESIGN.md`：today 契约段（新增批量端点、移除 sessionTasks）。
3. `docs/PHASES.md` + `docs/phases/phase-7-today-navigation.md`：新阶段留档（目标、完成标准、决策记录）。

## 10. 部署注意

- 1.9G 内存小实例：`pnpm --filter @el/web build` 时设 `NODE_OPTIONS=--max-old-space-size=1024`；earlyoom 已在位；沿用分步部署脚本，不并发多个重任务。

## 明确不做（YAGNI）

- 不做进度条多彩/渐变（Quiet UI）。
- 不加 framer-motion 等动画库。
- 不做撤销任务在进度条上的独立样式（按未做着色）。
- 不改后端 currentTask 选择逻辑（仍为首个未完成）。
- 不做跨设备会话续接相关改动。
