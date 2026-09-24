# Phase 4 — 表达与个人例句（Production + Practice）

**状态：planned**

## 目标

主动输出闭环：表达题生成（受控中文提示）、实时 AI 批改（三档判定 + 最小纠错 diff + 可选 better version）、Personal Example 沉淀（≤3、pinned 保护、自动替换）、Library“练一下”。

## 模块

AI `generate_production_prompt / check_production`；today 的 Production 路径（P-L1/L2 填空在 Phase 3 已有，P-L3 混合、P-L4+ 表达题在本阶段）；`library practice`；前端批改 UI（红删绿增、better_version 折叠、pin 收藏、造句历史）。

## API

`POST /api/library/:id/practice`、`POST /api/library/:id/practice/:questionId/answer`、`POST /api/library/:id/master`、PATCH library 支持 personal examples 编辑与 pin/unpin。

## 测试点

- check_production：Schema 校验、segments 重建原句与 corrected_sentence（失败重试）、批改失败不推进 Stage 且保留输入。
- personal_example_candidate：仅 result≠fail 且 eligible 才入库；corrected 版本；上限 3；替换规则（新分 > 最差 unpinned +0.1）；pinned 永不自动淘汰。
- practice：不改 Stage/next_review_at、不造补强、不计 Today 进度与热力图；表达题优质句仍可入 Personal Example。
- 造句历史每 Item 最近 10 次（含 library practice 的表达作答）。
- E2E：答一道表达题看到 diff、收藏一条 personal example。

## 完成标准

- 表达题端到端可用，diff 渲染正确。
- check_production 真实模型 Eval 通过率达标并出对比报告（需 GLM key）。

## 决策记录

（暂无）
