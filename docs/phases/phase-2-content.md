# Phase 2 — 内容进出（Library + Import/Export + New Queue）

**状态：planned**

## 目标

不依赖复习引擎的内容闭环：PC 导入 JSON → 预览（AI 重复建议，用户逐条确认）→ 提交 → New Queue → Library 管理 → 学习库导出。

## 模块

后端 `learning-items`、`import-export`（接入 judge_duplicate_meaning）；前端 `library` feature + PC 导入向导。

## 数据表（开始写入）

learning_items、learning_examples、settings（已有）

## API

`GET/PATCH /api/library`、`GET /api/library/:id`、pause/resume/archive/restore/reset、`POST /api/import/preview`、`POST /api/import/commit`、`GET /api/export/library`（master 端点实现但 UI 可后置）

## 测试点（TDD 先行）

- 重复决策 helper：merge / new_item / skip_exact_duplicate 语义；AI 只建议、用户确认。
- 同 target 归一化（大小写/空白/标点）才触发 AI 判定。
- merge：保留已有 source example、新例句入 extra 候选、不重置进度、每 Item 恰 1 条 source。
- commit 幂等（同 preview token 不重复入库）。
- 编辑 target/meaning → 该 Item fresh/active 题全部 retired（逻辑先测后接，Phase 3 有真实题数据后再回归）。
- Library 全字段搜索 + 固定筛选（类型/状态）；分页。
- 导出 → 再导入 round-trip 幂等。
- E2E：PC 导入样例 JSON → 预览改一条决策 → 提交 → Library 可见可搜。

## 完成标准

- 产品 DoD“PC 导入 + 预览逐条处理 + New Queue”条目通过。
- 手动跑一次 judge_duplicate_meaning 真实 Eval（如已有 GLM key）。

## 决策记录

（暂无）
