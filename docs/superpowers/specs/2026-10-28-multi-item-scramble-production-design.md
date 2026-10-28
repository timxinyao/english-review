# Multi-item Scramble Production — 设计 Spec

日期：2026-10-28。状态：设计已获产品确认（对话分节过审：题面 → 抽词/判定/计数 → 界面/旧数据/范围；历史 Production 数据允许一次性清干净）。

> 本文是后续实现的契约草案。实施前另开阶段计划；**本期只落文档，不改产品代码、不部署。**  
> 权威产品/技术全文（`PRODUCT_DESIGN` / `TECHNICAL_DESIGN` / `DATABASE`）在实现阶段再同步改写，避免双源漂移。

## 1. 背景与问题

当前正式 Production（表达）是：中文题干可见目标词 → 用户**整句英文打字** → `check_production` 实时批改。

实测问题：

- 听力仍在 A1～A2、阅读 A2～B1 时，整句自由写同时考句型与拼写，负担过大；造句通过率偏低。
- Word / Chunk 的表达交互不一致（Word 默认关 Production，Chunk 默认开且走同一套打字造句）。
- 一题只绑定一个 `learning_item_id`，无法「多词一起组句、结果按词拆开回写」。

产品决策（2026-10-28）：

- **不要**整句打字造句；**不要**挖空填目标词（不恢复 V1 cloze）。
- 正式表达改为 **拼词（chip scramble）**：中文题干 + 打乱英文词芯片 + 干扰项，点选拼句。
- Understanding（Recall）对 word / chunk **一视同仁**。
- 拼词对 word / chunk **同一套**；一道题可捆绑多个到期项，批改后**按项独立回写** Production 状态。
- 历史旧式 Production 数据用不久，**允许字段级删除与干净切断**，不做长期双轨兼容。

## 2. 目标与非目标

### 2.1 目标

1. 用 **scramble / chip assemble** 替换正式 Production 的整句打字路径。
2. 支持 **multi-item**：一题捆绑 2～3 个到期 Production 学习项（可混 word + chunk），句子必须用上全部目标。
3. Chunk **拆成单词级芯片**（不整块送分）；目标词块在芯片堆里与其它词一并打乱。
4. **Per-item writeback**：提交后每个目标独立判 pass/fail，分别推进该维度 FSRS / `review_states`（例：`d` 错、`a`/`b` 对 → 只打 `d`）。
5. UI 计 **1 道题**；今日计划 / soft-cap **扣 1 格**（不因捆绑 N 项扣 N）；进度仍更新 N 项。
6. 凑不出自然组合时 **降级单项目 scramble**（仍是芯片，不回退打字）。
7. 一次性迁移：清掉旧 free-typing Production 题库与相关作答证据，切换到新题型。

### 2.2 非目标（本设计明确不做）

- 不恢复 V1 挖空填目标词（cloze）。
- 不做语音输入 / STT / 发音评分。
- 不做游戏化（streak、成就、排行）。
- 第一版不做用户手动自选 `a+b+d` 组队（系统自动组队）。
- 不改 Understanding / Learn / Read 的主路径语义（除「Word 也统一可走新 Production」带来的开关默认与队列影响）。
- 本期不重写整份 `PRODUCT_DESIGN.md`（实现阶段再改）。

## 3. 用户体验

### 3.1 Understanding（不变主交互）

- Word 与 Chunk 都做 Recall：看 target + 语境 → 揭示 → 三档自评。
- 规则、Stage、FSRS U 维度与现行一致。

### 3.2 Production 新题面（Today）

1. **题干**：中文意思（一句，覆盖本组全部目标的用法）。
2. **目标提示**：可淡显示本次 2～3 个目标（lemma / chunk 原文），降低完全盲猜义项；**不**预先展示完整英文参考句。
3. **芯片区**：打乱的英文词芯片（含目标拆词 + 句中其它词 + 干扰项）；已选芯片排成一行，支持点掉重排。
4. **提交**：整句对错简述 + **每个目标**的对/错标记；再进入下一题（理解或下一组拼词）。
5. **主动不会 / 稍后 / 撤销 / 坏题**：语义对齐现有 Today 卡片流；撤销后重答须换新 scramble 题（同组目标可重抽或换组合，实现阶段定细则）。

### 3.3 Library「练一下」

- 需 Production 时：一道 Recall + 一道 **单项目或小捆绑 scramble**（实现阶段默认：练一下优先单项目 scramble，避免和正式 multi-item 抢组队逻辑）。
- 仍不改变正式 Stage / 排期 / Today 结算 / mastered。

### 3.4 Word 与 Production 开关

- Word 与 Chunk **共用** scramble Production 路径。
- `production_enabled_override` 仍生效：Library 可单条关闭 Production。
- **默认策略（推荐，实现前可在阶段计划再确认一次）**：保持现行默认 —— Word 默认关、Chunk 默认开；本设计不强制把存量 Word 全打开，只保证「一旦开启」走 scramble 而非打字。若产品希望 Word 也默认开，另开决策记录。

## 4. 数据模型变更

### 4.1 现状约束

- `review_tasks.learning_item_id`：**一题一项**。
- `questions.learning_item_id` + `type = production`：单目标表达题；`payload_json` 含 `mustUse` / `referenceAnswer` / `acceptanceNotes` 等（见现行 `generate_production_prompt` / `check_production`）。
- `attempts`：一作答一行，主关联一个 `learning_item_id`；Today 结算读写该行对应项的 Production `review_states`。
- Soft-cap / 今日计划按 **task 数** 入队（Phase 12）。

### 4.2 Schema 选项

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A. 联结表 | 新增 `review_task_items`（及可选 `question_items`）；task 可保留「主项」FK 或改为可空 | FK 清晰；按项写回、查询、撤销都干净 | 迁移面略大；队列/撤销路径要改 |
| B. JSON 参与者 | 保留 `learning_item_id` 作 primary；`participants_json` 列存其余 id + 每项结果 | 改表小 | 无 FK；部分更新易脏；统计/坏题边界糊 |
| C. 仅扩 payload | multi-id 只放 `questions.payload_json`，task 仍 1:1 假装主项 | 表面改动少 | 队列「一项一题」假象破坏 soft-cap 与回写语义 |

### 4.3 推荐方案：**A — 联结表 + question 多目标载荷**

**推荐采用 A**，理由：per-item writeback、撤销快照、坏题影响范围都需要稳定的「task ↔ 多个 learning_item」关系；产品已明确要干净切断，不值得用 JSON 双轨凑合。

#### 4.3.1 `review_task_items`（新表）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | text PK | |
| review_task_id | FK → review_tasks | |
| learning_item_id | FK → learning_items | |
| role | text | `primary` \| `participant`（展示/排序用；结算一视同仁） |
| result | text nullable | `pass` \| `basic_pass` \| `fail` \| `void`；提交后填写 |
| sort_index | integer | 目标展示顺序 |
| created_at | datetime | |

唯一约束：`(review_task_id, learning_item_id)`。索引：`learning_item_id`。

#### 4.3.2 `review_tasks` 调整

- **保留** `learning_item_id`：迁移期与单项目路径的兼容主键；语义改为 **primary 展示项**（联结表中 `role=primary` 的那一项），必须存在于 `review_task_items`。
- `task_type`：继续用 `production`（或实现时引入 `production_scramble`；**推荐仍用 `production`**，用 question payload / prompt_key 区分世代，避免扩大 task_type 枚举）。
- Soft-cap / 计划计数：继续 **按 task 行数 = 1**。

#### 4.3.3 `questions` 调整

- 保留 `learning_item_id` = primary 目标（生成追溯、旧索引）。
- 新增可选联结 **`question_items`**（与 task 对称），或在 cutover 后仅依赖 `payload_json.targets[]` + 运行时校验 FK。  
  **推荐**：payload 内声明 targets（生成契约），另建 `question_items(question_id, learning_item_id, sort_index)` 便于「某项题库失效 / target 变更 → 退役相关题」。
- `type`：仍为 `production`。
- `payload_json`（新世代示意）：

```json
{
  "schema": "scramble_v1",
  "targets": [
    { "learningItemId": "…", "surface": "wear down", "tokens": ["wear", "down"] }
  ],
  "zhPrompt": "长期开会让我很累。",
  "referenceTokens": ["Long", "meetings", "really", "wear", "me", "down"],
  "distractors": ["wear", "out", "tire"],
  "acceptableMorphology": ["wear", "wears", "wore"],
  "acceptanceNotes": "…"
}
```

- 旧 free-typing payload（`mustUse` / `referenceAnswer` 整句字符串等）在 cutover 后不再生成；存量按 §7 删除。

#### 4.3.4 `attempts` 调整

- 保留一行 attempt 对应一次提交（一题一次）。
- 新增 `item_results_json`（或子表 `attempt_item_results`）：每目标 `{ learningItemId, result, detail? }`。  
  **推荐子表** `attempt_item_results`，便于按项审计与 FSRS 回放。
- 顶层 `attempts.learning_item_id` / `result`：主项汇总（例如任一 fail → 题级 `fail`；全 pass → `pass`；仅用于列表摘要与 daily_stats 的「题级」计数）。**FSRS Production 只读 per-item 结果，不读题级一刀切。**
- `answer_text`：保存用户拼出的 token 序列（空格连接或 JSON 数组）；不再期望自由散文。
- `correction_json`：改为 scramble 反馈结构（缺词、错序、干扰项误用、每目标标记）；不再依赖整句 diff / Personal Example 自动沉淀路径（见 §4.3.6）。

#### 4.3.5 `review_states`

- 维度 `production` 仍按 **learning_item** 一行；multi-item 一题对 N 行各调用一次 `advanceReviewState`（独立 Rating）。
- Rating 映射建议对齐现行：未通过→`Again`；基本通过→`Hard`；通过→`Good`（若 scramble 第一版只区分对/错，则 basic_pass 可暂不产出，只 `Good`/`Again`）。

#### 4.3.6 Personal Example

- 旧造句沉淀的 Personal Example：**推荐保留**（语言资产，与「清 Production 题/答」可分离）。
- 新 scramble 路径：**第一版默认不自动写入 Personal Example**（点选拼句不是用户原创产出）。若未来要沉淀，另开产品决策。
- 实现阶段从 `check_production` 自动收藏逻辑断开 scramble 题。

## 5. 生成流程

1. Session 创建 / 追加复习入队时：收集「今日该练 Production 且 `production_enabled`」的到期项（FSRS `next_review_at` 最早优先），在 soft-cap 剩余名额内组队。
2. **组队**：贪心或小搜索，2～3 项一组；启发式 —— 同语义场 / 可共现、避免近义互扰过度、长度上限（参考句 token 数上限，实现阶段定数，建议 ≤12～16）。
3. 组不成 → **单项目** scramble 任务。
4. 每组调用新 Prompt（建议名）：`generate_production_scramble`  
   - 输入：各 target + meaning + 少量例句；要求产出中文题干、参考 token 序列、干扰项。  
   - 干扰项数量 ≈ 参考句 token 数的 **30%～50%**。  
   - Chunk 必须拆成 word tokens 进入芯片池。  
   - 不得在 UI 可直读字段里预置「完整已拼好的答案行」给前端默认展开（参考句仅服务端批改用，或前端仅在提交后揭示）。
5. 题目入库：`questions` + `question_items`；绑定 `review_tasks` + `review_task_items`。
6. 生成仍遵守：不在 SQLite 写事务内等待 AI；失败留 pending 可重试，不降级为打字题或 cloze。

## 6. 批改与回写

### 6.1 批改

1. 规范化用户 token 序列（大小写、简单标点策略实现阶段定）。
2. **整句层**：与 `referenceTokens` 顺序匹配，或接受白名单形态变化（如 `wear`/`wears`）；可选极小编辑距离仅用于反馈文案，**不以「整句通不通」单独决定所有目标的命运**。
3. **目标层**（每个 target）：  
   - 其 `tokens`（按序）是否都出现在用户序列的正确相对顺序中；  
   - 是否被拆散误用 / 被干扰项替换；  
   - → 该项 `pass` 或 `fail`（第一版可不引入 `basic_pass`）。
4. 判定可先规则为主；边界案例再调用精简 AI Judge（新 `check_production_scramble`）。**禁止** AI 直接返回要写入的 Stage / next_review_at（沿用 AGENTS 禁令）。

### 6.2 回写

- 同一事务内：写 attempt + per-item results；对每个非 void 目标调用 Production FSRS；更新 task 完成态；按规则插补强（**建议**：仅 fail 的项可触发该项目的补强策略；multi-item 一题最多产生的补强条数要有上限，避免一题爆炸。默认：每 fail 项至多 1 条，且受「每项每 Session ≤2 条补强」全局帽约束）。
- **今日计划 / soft-cap**：完成本 task 计 **1** 次正式题；`daily_stats.formal_tasks_completed` +1；`production_attempts` +1（题级）；`production_pass` 仅当题级 pass 时 +1。另可加可选计数「production_item_pass/fail」——非必须，实现阶段决定。
- 积压：按 **learning_item** 是否仍 due 计算；一题推进多项时多项可同时离开 due。

### 6.3 撤销 / 坏题

- 普通撤销：恢复 **所有参与项** 的 pre_state 快照；作废 attempt 及 item_results；取消本任务产生的补强。
- 坏题：题进入 `bad_question`；本尝试 void；回滚所有参与项本次状态变化（与单题坏题同级严格）。

## 7. 迁移与历史清理（一次性干净切断）

用户明确要求：历史 Production 相关可以不要，字段可删，**做干净**（2026-10-28）。

### 7.1 Cutover 标记

- `app_metadata` 增加键如 `production_scramble_v1`（UTC ISO 切换时刻），boot 幂等：已切换则跳过破坏性步骤。

### 7.2 删除 / 退役候选（破坏性，故意）

| 对象 | 动作 | 说明 |
| --- | --- | --- |
| `questions` where `type='production'` 且 payload 非 `scramble_v1`（或全部旧 production） | **DELETE** 或先 `retired` 再物理删 | 含缓存的 free-typing 表达题；不再留双轨出题 |
| 旧 `cloze` 题（若库中仍有） | 可一并 DELETE | V2 已不分配；趁切干净 |
| `attempts` where 关联 production/cloze 旧题，或 `ai_prompt_key` in (`check_production`, …) 且非 scramble | **DELETE** 或 void 后删 | 去掉旧 P 证据；FSRS 不再回放这些行 |
| `review_tasks` 未完成的旧 `task_type='production'` | 取消或删除后按新逻辑重建 Session | 避免半旧半新 Session |
| `correction_json` / 题级打字草稿 | 随 attempt 删除 | |
| Prompt 文件 | 保留 `generate_production_prompt` / `check_production` 直至实现替换后标 deprecated 再删 | 文档阶段先登记，代码阶段再动 |

### 7.3 `review_states`（production 维）

干净切断推荐：

- **重置**所有 learning_item 的 Production 维：`difficulty/stability/reps/lapses/last_review_at/next_review_at` 置未激活（NULL/0 按现行未激活语义），`correct_streak/wrong_streak` 清零。
- 然后：对仍 `production_enabled` 的项，按产品规则重新激活 P（例如 Learn 已完成者给予初始 due，或自切换日起按「下一本地日首次 scramble」——与现行「Learn 后下一本地日」对齐，实现阶段写进阶段计划）。
- **不要**用已删除的旧 production attempts 做 FSRS 回放。

Understanding 维、Learn、Read、`learning_items` 本体、例句 `learning_examples`（含 Personal Example）**默认不动**。

### 7.4 统计与备份

- `daily_stats` 历史行保留（过去数字可作废品，不强制清零）。
- 完整备份格式：实现阶段升版本号，注明「无旧 production 题/答」；恢复旧备份时若含旧 production，恢复流程应再跑同一 cutover（幂等）。

### 7.5 字段级删除（可选同一 migration）

若实现时确认无代码路径依赖，可删除仅服务于打字造句的冗余列/JSON 键约定；**优先删数据行与题型载荷，少删列**，降低迁移风险。需要删列时在 `DATABASE.md` 与 drizzle migration 同步列出。

## 8. Today 队列与 soft-cap

- 入队单位：scramble **task**（1 行 = 1 计划名额）。
- 捆绑 2～3 项仍只占 **1** 名额；多项进度在提交时一并更新。
- 补强、Later、跨日 409、过期 Session 标记：沿用 Phase 12 语义，仅把「单 item production」扩展为「task 多 item」。
- Prefetch：按组生成 scramble；失败策略同现网（pending + 重试）。

## 9. 开放问题（少量）

1. Word 默认是否仍关闭 Production，还是切换后改为默认开启？（推荐暂保持默认关。）
2. Scramble 第一版是否需要 `basic_pass`，还是仅 pass/fail？
3. Personal Example：确认「保留旧 PE + 新题不自动写」是否最终方案。
4. 参考句 token 上限与干扰项比例的具体常数（建议先 30%～50%、句长 ≤16 tokens，上线后按通过率调）。

## 10. 范围外

- 用户手动挑选词条组队。
- 挖空、语音、游戏化。
- 多账号 / 同步 / 新技术栈。
- 本次提交不修改业务代码与部署配置。

## 11. 成功标准（实现阶段验收）

1. Today 正式 Production 仅出现 scramble 芯片题；无整句打字框、无目标挖空。
2. 一道题可含 2～3 个目标；提交后各项 Production 状态独立变化；UI 只计 1 题，计划只扣 1。
3. Chunk 以单词芯片出现；干扰项大致落在句长 30%～50%。
4. 组队失败时单项目 scramble 可用。
5. Cutover 后库中无旧 free-typing production 题/答作为出题或 FSRS 证据；U 与 Learn 数据完好。
6. 撤销 / 坏题对多参与项回滚正确；AGENTS 所列后端强制规则不被 UI/AI 绕过。
7. 单测 + Today/Production 集成回归 + 关键 E2E 通过后再改 `PRODUCT_DESIGN` / `DATABASE` / `PHASES` 并留档。

## 12. 文档与阶段

- 本文件路径：`docs/superpowers/specs/2026-10-28-multi-item-scramble-production-design.md`。
- 实现启动时：在 `docs/PHASES.md` 新增 planned/in-progress 阶段（建议 Phase 13），并建 `docs/phases/phase-13-*.md`；同步改产品/技术/库表文档与 Prompt。
- 本提交：**仅本 Spec**（不为提前占位改 PHASES）。

## 13. 决策摘要

| 点 | 决策 |
| --- | --- |
| 题型 | 中文题干 + 词芯片拼句 + 干扰项 |
| 多词 | 2～3 项自动组队；按项回写 |
| Chunk | 拆词芯片 |
| 计数 | 1 题 / 扣 1 计划格 / 更新 N 项进度 |
| 降级 | 单项目 scramble |
| 旧数据 | 一次性删除旧 production 题与作答证据，重置 P 维 FSRS |
| Schema | 推荐联结表 `review_task_items`（+ attempt/question 侧对称） |
| 不做 | cloze、打字造句、语音、游戏化、手动组队 |
