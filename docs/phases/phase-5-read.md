# Phase 5 — Read（上下文复现）

**状态：planned**

## 目标

Read 闭环：选词（focus 3–5 弱项 + old 3–5 稳定项）→ 生成 180–400 词短文 → 高亮 focus → 1–2 道轻量检查 → 答错置 needs_reinforcement → 下次 Today 补一题正式复习 → 历史/收藏/30 天过期。

## 模块

后端 `read`；AI `generate_read`（coverage 校验失败重试/拒绝）；today 的 read_reinforcement 接入；前端 `read` feature。

## API

`POST /api/read/generate`、`GET /api/read/history`、`POST /api/read/:id/favorite`、`POST /api/read/:id/check`

## 关键实现决策

- read_reinforcement 任务：按 PRODUCT 6.3 阶段映射取当前阶段题型（默认理解维度选择题）；完成后清 needs_reinforcement。
- focus 覆盖校验（coverage 与正文实际出现）不过 → 重试 ≤2 → 拒绝并提示。
- Read 完全不影响 Today 完成状态。

## 测试点

- 字数约束（英文词计数）、coverage 完整性、checks 数量 1–2、选项合法。
- check 答错只置 needs_reinforcement；下次 start 生成 read_reinforcement 任务；完成清旗。
- 普通文章 30 天过期、收藏永久；History 分页。
- E2E：生成一篇 → 高亮可见 → 答错 → 次日 Today 出现补强任务（时间偏移模拟）。

## 完成标准

- Read 全流程可用；Stage 零影响经测试验证。

## 决策记录

（暂无）
