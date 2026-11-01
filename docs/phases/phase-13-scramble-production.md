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

## 变更日志

### 2026-11-01 修复：字典形 target 防线（预取失败回归）

**现象**：`english-learning-prefetch` 自 2026-10-29 起 exit 1——`reference_tokens 未按序覆盖 target_surface "doze off" / "wear down" / "get one's butt kicked"`，重试 2 次仍失败。

**根因（双重）**：

1. Prompt v1 未要求 reference 使用字典原形，glm-5.3 按自然语感写屈折形（dozed off / wears down）或替换占位代词（get his butt kicked）。
2. 旧不变式只对比**模型自己 echo 的 `target_surfaces`** 与模型自己的 `reference_tokens`（自指校验）：模型改写 echo（如 "got our butts kicked"）时静默通过并把漂移 tokens 写入批改目标（悄悄削弱批改）；模型诚实回显字典形但 reference 屈折时才失败——两类行为随机出现，失败仅是冰山一角。

**修复**：

- Prompt 升版 `generate_production_scramble.v2.md`：字典形硬约束（禁屈折/占位替换/echo 改写）+ 构句技巧（一般现在时/祈使/情态原形/动名词主语）+ distractors 数量硬带（多目标长句 4–8 个）。
- `invariants.ts`：字典形覆盖按输入 `targets` 校验（fail-closed）；`target_surfaces` 逐词归一化回显校验（拦词级漂移，容忍标点/省略号——句式 target 如 `Is it just me, or...?` 可满足）。
- `questions/service.ts`：入库 targets 恒用字典形 target（不信任 echo），service 层同口径双校验（AGENTS §5：AI 不得绕过业务规则）。
- 数据修复：退役 6 道旧自指校验放行的漂移 fresh 题（butt kicked ×2、I'm good on... ×2、Is it just me, or...? ×2），由预取按新 prompt 重生成。

**决策**：

- echo 一致性用逐词归一化而非裸字符串比较：句式 target 含省略号/标点，裸比较会让该类 target 永远无法通过校验。
- `acceptable_morphology` 维持"仅展示元数据"定位（`judgeScramble` 芯片拼句天然只能拼出参考形，不参与等价类判定）。

**Eval**：fixtures 4→6（补句式省略号 target 两个 case），真实模型 glm-5.3 6/6 通过，v1 基线 4/4 失败复现根因；基线已保存 `tests/ai/eval/baselines/generate_production_scramble.json`。

**生产部署核验（2026-11-01 11:07）**：deploy.sh 部署后手动触发 prefetch——首轮 get one's butt kicked 3 次重试全挂（温度 0.7 残余方差，one's 类 target 每次尝试约有失败概率），次轮 exit 0：生成 2 题、surface 全部字典形；doze off / wear down / get one's butt kicked / I'm good on... / Is it just me, or...? 五项库存均补齐至 2。已知限制见下。

**已知限制**：one's 类 target 在 glm-5.3 + temp 0.7 下单次尝试仍有失败概率（观测过一次 3/3 全挂、随后 6/6 全过），completeStructured 盲重试（同 prompt 无违规反馈）无法利用模型一次提醒即可自纠的特性。后续可选增强：违规反馈重试（把上次 violation 附进重试请求）。当前依赖：次日预取补齐 + §14 懒生成兜底。
