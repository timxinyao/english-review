# Phase 3 — 复习引擎与 Today（理解 + 填空）

**状态：planned**

## 目标

核心学习循环跑通：Today 开始/恢复 → Learn 卡 → 理解题/填空题作答 → 状态机推进 → 补强 → later → 完成摘要；题目预生成 + 懒生成；幂等与并发安全。本阶段是最大关键阶段。

## 模块

后端 `review`、`today`、`questions`、`jobs/daily-prefetch`；AI `generate_understanding / generate_cloze / check_cloze`；前端 `today` feature（Learn 卡、选择题 shuffle、填空、later、guessed/too_easy/查看原句、完成摘要）。

## 数据表（开始写入）

review_states、review_sessions、review_tasks、questions、attempts、daily_stats

## API

`GET /api/today`、`POST /api/today/start`、`POST /api/today/tasks/:id/answer`、`POST /api/today/tasks/:id/later`、`POST /api/today/tasks/:id/bad-question`

## 关键实现决策（已确认默认值）

- pass：level+1，next=新级间隔；L7 到期再 pass → stable。
- basic_pass：level 不变，next=当前级间隔×0.5（min 1 天）。
- fail：level-1（min L1），next=降级后间隔×0.5（min 1 天）。
- too_easy：pass 基础上最多额外 +1 级；guessed 按 fail；viewed_source 结果上限 basic_pass。
- 补强插入位置：max(当前位置+3, 队列后 30% 起点)；单 Item 单 Session ≤2。
- Learn 为单任务内嵌首道理解题；首题答对 → U=L1(+1d)、P 激活(+1d)；答错不激活，走补强。
- queue_state 在 Learn 完成时置 started；当日额度按当日完成 Learn 计数（daily_stats）。
- 时间源注入（不 sleep）；session_date 按 APP_TIMEZONE。

## 测试点

- 状态机全结果矩阵 ×（U/P 两维）、mastered 判定。
- answer 幂等/并发：同 task 只结算一次，事务内检查 completed_at。
- New Queue 每日额度、跨天恢复、中途放弃可重入。
- later 不写 attempt、只加 defer_count 移位；完成条件=无非 canceled 任务。
- 坏题撤销：question→bad_question、pre_state 快照恢复、取消该 attempt 产生的补强、attempt void。
- cloze 本地判定（归一化+accepted）→ AI 兜底路径；拼写错误拒绝。
- 题库存量检查、预生成 job、懒生成、retired/bad 生命周期。
- 选择题 shuffle 后提交 option id 正确。
- E2E：完成一个含 Learn+理解+填空+补强的完整 Session。

## 完成标准

- 用时间偏移模拟 3+ 天复习，调度与状态断言正确。
- Today 相关产品 DoD 条目全部通过。

## 决策记录

（暂无）
