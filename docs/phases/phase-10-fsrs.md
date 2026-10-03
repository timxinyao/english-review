# Phase 10 — FSRS 记忆调度替换固定阶梯

开始：2026-10-03。状态：in-progress（文档收尾中，验收结果待部署后回填）。目标：复习排期核心从 V1.2 固定阶梯（1/3/7/14/30/60/120 天、L1..L7、tooEasy 跳级）换轨为 FSRS 记忆调度，产品层与历史数据不动。

设计 spec：[2026-10-03-fsrs-scheduler-design.md](../superpowers/specs/2026-10-03-fsrs-scheduler-design.md)（含 §7 实施修订）。实施计划：[2026-10-03-fsrs-scheduler.md](../superpowers/plans/2026-10-03-fsrs-scheduler.md)。

## 关键决策

4 个设计点（spec 已批准）+ 3 个实施修订（实施期 controller 裁定）：

| # | 决策 | 说明 |
| --- | --- | --- |
| 1 | 目标记忆率 0.90；官方默认参数 | ts-fsrs（MIT）；个人拟合攒 ≈1000 条作答后另立项（范围外）。 |
| 2 | mastered = 所需维度 stability ≥ 120 天 | 替换「两维均 stable」；目标开关变化 reconcile 沿用新谓词。 |
| 3 | 切换初始化 = attempts 全量回放 | 仅 `mode='today'` 的 understanding/production 题；cloze/read_check/library_practice/void 跳过。 |
| 4 | 间隔 clamp 1..365 天 | FSRS 输出浮点天，`next_review_at = 结算时刻 + 间隔`。 |
| 修订 1 | `enable_short_term=false` | ts-fsrs 分钟级学习步与天粒度排期不兼容（1 天下限下塌缩且 Again/Good 首答不可区分）。 |
| 修订 2 | 旧备份恢复按 level/stable 折算，不回放 | 备份不含 attempts；`estimateFsrsFromLegacy`：stable→S=120、L1..L7→1/3/7/14/30/60/120、D=5、reps=level。 |
| 修订 3 | `review_states` 加 `reps`/`lapses` 列（NOT NULL 默认 0） | FSRS Card 跨重启完整重建必需（New/Review 态区分），超出 spec §2 字面。 |

## 范围

- 引擎封装 `fsrs-engine.ts`（参数、评分映射、clamp、Card 重建、回放纯函数）。
- migration 0007：删 `level`/`stable`，加 `difficulty`/`stability`/`reps`/`lapses`；快照/序列化/阶段标签（按 S 分档）同步。
- `fsrs-cutover.ts`：`app_metadata` 标记 `fsrs` 幂等回放；boot 顺序 迁移 → Prompt Registry → v2 cutover → fsrs cutover → listen。
- 备份 2.0 含 FSRS 字段 round-trip；旧格式恢复折算。
- 文档同步（PRODUCT §6.1/§6.2/§6.3/§7.1/附录 A、V2 生效规则、DATABASE、TECHNICAL §8、spec §7）。

## 完成标准

- [x] 引擎与状态机单测重写（Good 单调增长、Easy>Good、Again 缩短、S≥120 mastered、streaks 照常）。（Task 1，3faf4f7）
- [x] 0007 切换 + 快照/序列化/标签/备份字段。（Task 2，aaf4728）
- [x] 回放迁移 + 旧备份折算 + boot 接线；幂等（二次运行字节级 no-op）。（Task 3，7f648e6+32895e3）
- [x] 全门禁：lint / typecheck / test / prettier / git diff --check / E2E 全量。
- [ ] 部署 + 冒烟 + 生产库回放验证（下方回填）。

## 验收结果（部署后回填）

<!-- placeholder-start -->

- 全门禁（2026-10-03）：待回填。
- 部署与冒烟：待回填。
- 生产库验证（readonly，/var/lib/english-learning/english-review.db）：待回填——① `app_metadata` 出现 `fsrs` 标记且时间戳=本次 boot；② `review_states` understanding 维度 D/S 非空数、S 分布 1..365；③ `learning_items.status` 分布与部署前量级一致（active≈63）；④ `next_review_at` 超出 366 天的行数=0。

<!-- placeholder-end -->

## 变更日志

| 日期 | 变更 |
| --- | --- |
| 2026-10-03 | Task 1（3faf4f7）：ts-fsrs 引擎封装——参数（0.90/365/short-term off）、评分映射、演进 clamp、快照重建、回放纯函数；状态机单测重写。 |
| 2026-10-03 | Task 2（aaf4728）：migration 0007 原子切换（删阶梯列加 D/S/reps/lapses）、mastered=S≥120、快照/序列化/阶段标签（stabilityStageLabel）同步；顺手修三项留档。 |
| 2026-10-03 | Task 3（7f648e6+32895e3）：`fsrs-cutover.ts` 幂等回放（today 正式作答重建 D/S + reconcile）、boot 接线、旧备份 level 折算恢复；guessed 补偿语义修复。 |
| 2026-10-03 | Task 4：文档同步（本文件 + PRODUCT/DATABASE/TECHNICAL/PHASES/spec 实施修订）、全门禁、部署与生产验证。 |
