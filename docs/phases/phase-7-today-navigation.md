# Phase 7 — Today 会话导航改版

状态：done（2026-09-26）
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

- [x] GET /api/today/tasks 契约与实现（含撤销任务、已完成会话、无会话 409）
- [x] 进度条当前位置数字 + 按题完成着色（可间隔）
- [x] 列表弹层全量任务：回看 / 跳做 / 撤销置灰
- [x] 跟手 3D 翻页动画（reduced-motion 降级；键盘 ←/→）
- [x] 回看/已答题卡显示单词行（target + IPA）
- [x] 全量门禁通过（pnpm lint && pnpm typecheck && pnpm test；E2E today spec）
- [x] 文档同步（PRODUCT §5.1、TECHNICAL §6.2）

## 决策记录

- 2026-09-26 SessionTaskEntry 增加 canceled 字段（spec 漏项：弹层"已撤销"标记与滑动跳过撤销任务需要）。
- 2026-09-26 GET /api/today/tasks 在当日会话已完成时仍返回数据（spec 修订：最后一题反馈期间可回看）；仅无当日会话 409。
- 2026-09-26 SwipeDeck 动态 transform/perspective 用内联样式：交互位移非视觉样式，属"禁止内联 style"的允许例外。
- 2026-09-26 E2E 端口正式化：playwright.config/vite.config 读 E2E_API_PORT（默认 5174）——生产 API 常驻占用 5174，本机跑 E2E 需 E2E_API_PORT=5175；Task 7/E2E 曾发现 877f678 删除稍后再做按钮后既有 E2E 用例未同步（本迭代已修）。

## 变更日志

- 2026-09-26：开始（设计/计划见上）。
- 2026-09-26：交付完成——`GET /api/today/tasks` 批量端点（tests/unit/today-session-tasks.test.ts，6 测试）；shared 契约（移除未用 sessionTasks 概要、新增 SessionTaskEntry，含 canceled）；SwipeDeck 跟手 3D 翻页容器（6 测试）；TaskCard 回看/已答词行 target+IPA（4 测试）；ActiveSession cursor 导航模型 + 位置进度着色 + 全量列表跳做/键盘导航（today-navigation.test.tsx，10 测试，含 C1 冻结错配回归）；E2E 导航用例（today.spec.ts，2 passed）。门禁：lint 0 错误，typecheck 3 包通过，test 564 全过（api 44 文件 404 + web 25 文件 160），E2E 2 passed（E2E_API_PORT=5175）。
