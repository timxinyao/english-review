# Phase 12 — Today 会话软上限与积压反馈

> 起于 2026-10-27。来源：英语教练 Review 建议（停学后 due 全量入队曾出现 50U+17P、base_task_count 89）。

## 目标

1. **P0 Today 会话软上限**：创建 Session 时到期复习题按 next_review_at 最早优先最多入队 N 题（今日复习上限，默认 15，Settings 10/15/20/30/不限制）；Learn 新学按每日新学额度独立入队；超出部分保持 due 计入积压，之后每天重新纳入；未完成不算失败。
2. **P1 Idle 文案**：首页拆开展示「今日计划 N 题（复习 X · 新学 Y）· 积压还剩 M 题」，替换「今日到期 N 项」单一数字；无积压不显示积压段。
3. **P1 造句挫败反馈**：非主动不会的 fail 作答，在 diff 与解释之外同时揭示该题参考句与目标用法说明（来自题目 payload，不新增 AI 调用、不改 Prompt）。
4. **P2 工程债**：跨日未完成的历史 Session 在创建新 Session 时标记 abandoned_at（数据卫生，不挡今日路径）；today/service.ts 拆分本迭代不做，记为债项。

## 范围

- PRODUCT_DESIGN / TECHNICAL_DESIGN / DATABASE 同步更新（先文档后代码）。
- shared：settings 常量与 Schema、TodayIdleResponse 新字段、BackupSettings 新字段（旧备份缺省 15）。
- api：today service（start 截断、idle 计划/积压、fail 揭示、abandoned 标记）、settings、import-export（导出/恢复）。
- web：IdleToday 文案、SettingsPage 今日复习上限、ProductionQuestionCard fail 反馈。
- e2e：today idle 文案断言更新。

明确不做：复习「再来一批」按钮、streak 类展示、Prompt 版本变更、today/service.ts 大拆分。

## 完成标准

- [x] 默认 15 题软上限生效：100 due 只入队最早 15；Settings 可调；不限制恢复全量。
- [x] Learn 不被上限挤占（上限 0 复习时新学照常入队）。
- [x] 积压次日重新纳入（按最早优先滚动清偿）。
- [x] idle 返回 plannedReviews / backlogLeft；首页文案拆分展示。
- [x] 造句 fail（非主动不会）回传并展示 referenceAnswer / answerNote；pass / basic_pass 不变。
- [x] 过期未完成 Session 在下次创建 Session 时标记 abandoned_at。
- [x] `pnpm lint && pnpm typecheck && pnpm test` 通过（api 590 / web 303；typecheck 在 1.9G 小机需逐包串行，并行 tsc 会被 OOM SIGTERM；e2e 视部署验收补充）。
- [ ] 部署到生产并冒烟（health、idle 文案、软上限行为）。

## 决策记录

| 日期 | 决策 | 理由 |
| --- | --- | --- |
| 2026-10-27 | 上限只约束到期复习题；Learn/补强/再学一批不受限 | 新学已有独立额度上限，双重上限会互相挤压且语义混乱；痛点是复习积压爆炸 |
| 2026-10-27 | 默认 15（教练建议 10 或 15 之间取宽） | 默认 10 会把「10 新学 + 0 复习」极端化；15 给新学留余量 |
| 2026-10-27 | 造句 fail 反馈不加 AI 调用，只复用题目已有 payload | 零成本、零延迟、无 Prompt 版本问题；主动不会路径已有同一机制 |
| 2026-10-27 | abandoned_at 在 startTodaySession 事务内标记，不依赖周清理 timer | 每天 Start 必经路径，上线后第一次学习即清历史 8 条遗留 |
| 2026-10-27 | e2e 大队列 seed（seedLargeDueQueue）显式设上限=不限制 | 大队列场景测导航/手感不测软上限；保持「start 全量 pending」旧行为，today.spec 0/45 断言不变 |
| 2026-10-27 | parseBody 泛型改为 `S extends ZodTypeAny` 返回 `output<S>` | BackupSettings.todayReviewLimit 带 .default() 后旧签名把 T 推断成 input（可选字段），输出类型失真 |
| 2026-10-27 | 顺手修复 read 测试日期炸弹（固定 NOW+30d 于 2026-10-24 起过期，4 例在干净 HEAD 也失败） | 存量失败挡 pnpm test 门禁；种子改为相对真实运行时间，纯测试改动；read.test seedForGenerate 一处同类写法当前通过、未动 |
| 2026-10-27 | web 测试 fixture 补 todayReviewLimit / plannedReviews / backlogLeft | shared 契约新增必填字段的必要连带；apps/web 仅改测试与三处功能文件，未动手感文件 |

## 变更日志

- 2026-10-27：阶段开档，PRODUCT/TECHNICAL/DATABASE/PHASES 文档更新。
- 2026-10-27：shared 契约（settings/today/backup）、DB schema + 迁移 0009、API（软上限/idle 计划积压字段/fail 揭示/abandoned 标记/parseBody 输出类型）、web 接线（IdleToday 拆分文案、Settings 今日复习上限、fail 参考句）、e2e 断言与全部测试落地。
