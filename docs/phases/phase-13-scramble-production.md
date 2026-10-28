# Phase 13 — Multi-item Scramble Production

**状态：** done（2026-10-28）  
**目标：** 用「中文题干 + 词芯片拼句（可多词条、按项回写）」替换整句打字造句与正式填空。

## 交付

- `scramble_v1` payload；`question_items` / `review_task_items` / `attempt_item_results`
- Today：2–3 项贪心组队；一题扣 1 软上限；按项 FSRS 回写
- Library Practice：仅 scramble production
- Cutover `production_scramble_v1`：删除旧 production/cloze 题与 attempts，重置 P 进度
- Web：`ScrambleQuestionCard`；Today / Practice 提交 `{ selectedTokens }` 或 Today `{ giveUp: true }`

## 决策

- 不做挖空填目标词；不做整句自由打字
- Chunk 拆成单词芯片；干扰项混入
- 历史造句证据清空（用户明确要求做干净）

## 验证

- shared / api unit；web unit（scramble card + Today/Library production）
- 部署后 health；API boot 跑 cutover 一次
