# Phase 10 — FSRS 记忆调度替换固定阶梯

开始：2026-10-03。结束：2026-10-03。状态：done。目标：复习排期核心从 V1.2 固定阶梯（1/3/7/14/30/60/120 天、L1..L7、tooEasy 跳级）换轨为 FSRS 记忆调度，产品层与历史数据不动。

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
- [x] 部署 + 冒烟 + 生产库回放验证（下方回填）。

## 验收结果（2026-10-03 部署后回填）

- 全门禁（串行）：lint 0 / typecheck 0 / test api 49 文件 539 + web 34 文件 236（775 全过）/ prettier --check 变更文件全过 / git diff --check 0 / E2E **27/27**（--workers=1，1.1m）。E2e 首轮 26/27：`Learn→次日 Production` 的 libraryStates 断言读 `level`（0007 已删列，API 改返 difficulty/stability）——属 FSRS 行为变化而非回归，断言换 FSRS 语义（carry on P 未激活次日首排、set off 首答激活 D/S、put off 显式关闭 S5 不动）后全绿。
- 部署：`f78f1a7` push 后 `NODE_OPTIONS=--max-old-space-size=1024 ./deploy/deploy.sh` 一次成功（无 EACCES）；冒烟 systemctl active / `/api/health` {"status":"ok"} / web 200。
- 生产库验证（readonly，/var/lib/english-learning/english-review.db，首次 boot 自动回放）：
  - ① `app_metadata` 出现 `fsrs` 标记，value=boot 时刻 UTC ISO `2026-10-03T03:29:14.336Z`（服务 ActiveEnterTimestamp 11:29:12 CST=03:29:12 UTC，差 2s 即回放完成时刻）。
  - ② understanding：63 行、44 行 D/S 非空（有回放证据的已激活行），S 分布 0.07..23.3 天——库龄仅 9 天，无 120+ 项合理；production 63 行、仅 1 行激活（V2 cutover 2026-10-02 重置全部 P 后仅一天作答，符合预期）。
  - ③ `learning_items` status 分布 active=63，与部署前完全一致（无 mastered：S 最高 23.3 < 120）。
  - ④ `next_review_at > now+366d`（ISO 字符串比较）= **0** 行；全表 next 窗口 2026-09-29（已到期）..2026-10-24，分布合理。

## 总结

- 排期核心全量换轨 FSRS：引擎封装（0.90/365/short-term off）、0007 原子列切换、幂等回放 cutover、旧备份折算恢复、文档六处同步；产品层（补强/稍后/撤销/坏题/New Queue/Read）零改动。
- 生产切换一次成功：首次 boot 自动回放 44 个 U 维度激活行、D/S/next 分布合理、item 状态分布不变、无越界排期。

## 遗留问题（不阻塞发布）

- 个人参数离线拟合（py-fsrs）：攒 ≈1000 条作答后另立项（spec §6 范围外）。

## 变更日志

| 日期 | 变更 |
| --- | --- |
| 2026-10-03 | Task 1（3faf4f7）：ts-fsrs 引擎封装——参数（0.90/365/short-term off）、评分映射、演进 clamp、快照重建、回放纯函数；状态机单测重写。 |
| 2026-10-03 | Task 2（aaf4728）：migration 0007 原子切换（删阶梯列加 D/S/reps/lapses）、mastered=S≥120、快照/序列化/阶段标签（stabilityStageLabel）同步；顺手修三项留档。 |
| 2026-10-03 | Task 3（7f648e6+32895e3）：`fsrs-cutover.ts` 幂等回放（today 正式作答重建 D/S + reconcile）、boot 接线、旧备份 level 折算恢复；guessed 补偿语义修复。 |
| 2026-10-03 | Task 4（f78f1a7 + 收尾提交）：文档同步（本文件 + PRODUCT/DATABASE/TECHNICAL/PHASES/spec 实施修订）、e2e 断言 FSRS 化、全门禁、部署与生产验证；阶段 done。 |
