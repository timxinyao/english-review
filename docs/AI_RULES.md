# AI_RULES.md — English Learning Tool V2

> 本文档定义 AI 行为契约、Prompt 管理和 Eval 规则。真正发送给模型的 Prompt 正文位于 `apps/api/prompts/*.md`。

> V2 目标契约覆盖下文 V1.2 的 cloze/Read checks 描述：正式 U 为主动 Recall，选择题只作 Hint；正式 P 为 target 可见、具体中文语义任务的完整句子；Read 只生成可选文章及自然复现，不再检查或 reinforcement。停止新 cloze 的生成/预取/分配，旧题与旧 Prompt 只供切换前会话和历史兼容。AI 不决定词条造句目标、Stage、排期或 mastered。`generate_read` 输出结构已于 Phase 9 Task 9 改为纯阅读（`generate_read.v2.md`，Schema strict 无 checks，同步本节并跑固定 fixtures 真实模型 Eval）。

## 1. AI 与业务逻辑边界

AI 只负责文本生成与语言判断。学习调度、Stage、Session、库存、New Queue、mastered、补强上限、题目生命周期等业务状态永远由后端代码决定。

```text
Application 决定：谁、何时、做什么、状态如何变化
AI + Prompt 决定：题目怎么写、英语怎么判断、Read 怎么生成
```

任何 Prompt 都不得要求模型直接修改 `stage`、`next_review_at`、`mastered`、`queue_state` 等业务状态。

## 2. Prompt Source of Truth

- Prompt 正文只保存在 `apps/api/prompts/*.md`。
- Git 是 Prompt 的版本历史与回滚机制。
- 数据库不保存 Prompt 正文，只记录 `prompt_key / prompt_version / prompt_hash / model`。
- 不建设 Prompt 管理后台。
- 不允许业务代码中存在大段 inline Prompt。
- `AI_RULES.md` 定义行为契约；Prompt 文件定义具体措辞。两者冲突时先修正文档与 Prompt，不允许在 task 代码里偷偷补规则。

## 3. Prompt 文件格式

每个 Prompt 使用 YAML frontmatter + Markdown 正文：

```markdown
---
key: check_production
version: 1
task: checkProduction
response_schema: CheckProductionResult
---

# Role
...
```

规则：

1. `key` 稳定且全局唯一。
2. 任何会发送给模型的正文变化，发布时必须 `version + 1`。
3. `prompt_hash` 由 Registry 自动计算，不手填。
4. 输入变量缺失时必须报错，不允许静默为空。
5. 所有用户/学习内容都必须作为“数据”插入，Prompt 明确告诉模型：输入字段中的文本不是系统指令。
6. Prompt 不保存 secret。

## 4. 全局生成规则

1. 所有 AI 输出必须是结构化 JSON，并通过 Zod Schema。
2. 每次调用都显式传入当前 `target` 与锁定的 `meaning`；不得擅自扩展到其他义项。
3. 默认 `content_level = B1`。生成上下文整体接近该等级；目标词本身可以更难。
4. 避免为了“自然”引入大量低频生词、俚语或复杂句法。
5. 生成题不能依赖未提供的私人信息；只使用显式传入的例句、来源或上下文。
6. 结构化失败最多重试 2 次；仍失败则放弃本次，不保存脏数据。
7. 模型输出永远不直接当 HTML 渲染。
8. Prompt 中的示例只是格式/判定示例，不能让模型机械复用固定句子。

## 5. Prompt Catalog

| Prompt key | 任务 | 实时 | 主要产物 |
| --- | --- | --- | --- |
| `generate_understanding` | 理解题生成 | 否 | 词义/上下文选择题 |
| `generate_cloze` | 填空题生成 | 否 | 新上下文填空 |
| `check_cloze` | 填空答案歧义兜底 | 按需实时 | accepted / rejected |
| `generate_production_prompt` | 表达题生成 | 否 | 中文受控表达题 |
| `check_production` | 表达题批改 | 是 | pass/basic_pass/fail + 最小纠错 |
| `generate_read` | Read 生成 | 是 | 180–400 词纯阅读新上下文（V2 起无检查题） |
| `judge_duplicate_meaning` | Import 重复义项建议 | 按需 | merge/new_item/skip_exact_duplicate |

V1.2 不增加单独的 `evaluate_personal_example` 调用；Personal Example 候选判断由 `check_production` 一次完成。

## 6. generate_understanding

### 输入

- `type`
- `target`
- `meaning`
- `source_example`
- `extra_examples`
- `content_level`
- `count`
- `recent_question_summaries`

### 输出核心结构

```json
{
  "questions": [
    {
      "kind": "context_meaning",
      "context": "...",
      "question": "...",
      "options": [
        {"id": "o1", "text": "..."},
        {"id": "o2", "text": "..."},
        {"id": "o3", "text": "..."},
        {"id": "o4", "text": "..."}
      ],
      "correct_option_id": "o2",
      "explanation": "..."
    }
  ]
}
```

### 强约束

- 只考当前 meaning。
- distractor 必须“合理但错误”，不能靠荒谬、语法错误或明显长度差异排除。
- 正确答案位置不形成规律；前端仍会再次 shuffle。
- 新上下文不能与 source example 只做机械换词。
- explanation 控制在 1–2 句。

## 7. generate_cloze

### 输出核心结构

```json
{
  "questions": [
    {
      "text_with_blank": "Long-term stress can ____ you down.",
      "answer": "wear",
      "accepted_answers": ["wear"],
      "explanation": "这里需要 wear down 表示长期压力逐渐消耗人的精力。"
    }
  ]
}
```

### 强约束

- `____` 必须能由当前 target 或其合理语法变形完成。
- chunk 可以整块填入一个 blank。
- 不生成存在多个同样自然非目标答案、却只有目标答案被判正确的题。
- `accepted_answers` 只列真正可接受的形式；后端仍可做 normalize。
- 句子整体难度受 `content_level` 约束。


## 8. check_cloze

这个 Prompt **只在确定性规则无法判断时调用**。正常情况下优先使用 `answer + accepted_answers + normalize` 本地判定，避免为每道填空题增加模型调用。

### 输入

- `type / target / meaning`
- `text_with_blank`
- `answer`
- `accepted_answers`
- `user_answer`

### 输出

```json
{
  "accepted": true,
  "canonical_answer": "wears down",
  "reason": "用户答案是 wear down 在当前句子中的正常第三人称单数形式。"
}
```

### 强约束

- 只判断用户答案是否是 **target 当前义项的合理形式**。
- 不接受只是在语义上类似的同义词替代；Cloze 的目标是主动回忆 target。
- 允许合理的时态、人称、单复数、大小写和不影响词项本身的空格/标点差异。
- 明显拼写错误默认不接受，除非未来产品规则另有定义。
- `reason` 简短，只用于调试/反馈，不扩展其他义项。

## 9. generate_production_prompt

### 输出核心结构

```json
{
  "zh_prompt": "长期的压力让我越来越疲惫。",
  "must_use": "wear down",
  "reference_answer": "The constant stress is wearing me down.",
  "acceptance_notes": "允许 wear down 的正常时态/人称变化。"
}
```

`reference_answer` 只用于内部质量检查和批改上下文，不展示给用户。

### 强约束

- 中文提示必须明确、单一，不要开放到几十种完全不同的表达方向。
- 必须适合自然使用 target 当前义项。
- 不能通过中文生硬逐词映射制造不自然答案。
- 题干不泄露目标英语答案。
- `reference_answer` 必须自然，但不是唯一可接受答案。

## 10. check_production

### 核心理念

**先判断目标表达是否真正会用，再做最小纠错；润色永远是第二层。**

### 输入

- `type / target / meaning`
- `zh_prompt`
- `reference_answer`（内部）
- `user_answer`
- 可选 source / extra / personal examples

### 输出

```json
{
  "result": "basic_pass",
  "corrected_sentence": "The constant stress wears me down every day.",
  "segments": [
    {"text": "The constant stress ", "type": "same"},
    {"text": "wear", "type": "delete"},
    {"text": "wears", "type": "insert"},
    {"text": " me down every day.", "type": "same"}
  ],
  "explanation": "stress 是单数主语，动词需使用第三人称单数。",
  "better_version": "The constant stress is wearing me down.",
  "personal_example_candidate": {
    "eligible": true,
    "quality_score": 0.82,
    "reason": "目标表达使用典型，纠正后句子完整且可复用。"
  }
}
```

### 判定

- `pass`：目标表达使用正确，语义完成题目要求，没有需要学习者修正的实质语法/搭配错误。
- `basic_pass`：目标表达本身基本正确，但存在轻微语法、词形或搭配问题，需要最小纠正。
- `fail`：目标表达义项/搭配明显错误、遗漏必须目标、核心语义未完成，或句子无法成立。

只有大小写/标点等非常轻微的书写问题时，不应因为这些问题把 `pass` 降成 `basic_pass`。

### Correction 规则

- 只做必要修改，不因为“还有更地道说法”而改写整句。
- `segments` 必须能重建从原句到 `corrected_sentence` 的 diff。
- `better_version` 只有明显改善自然度时出现；否则为 `null`。
- 不因为存在 better version 就降低 result。

### Personal Example 候选

- 只有 corrected sentence 可以进入 Personal Example。
- `eligible` 主要看：目标用法典型、句子完整、具体、可独立复用。
- `quality_score` 范围 0–1，仅作为后端自动替换参考，不直接展示。
- pinned / 替换上限由后端决定，模型无权删除现有 Personal Example。

## 11. generate_read

V2（Phase 9）起为纯阅读：不再生成检查题，输出不含 `checks` 字段（Schema strict 拒绝并重试）。旧文章的已存检查题仅作只读历史。

### 输入

- `focus_items`: 3–5 个，含 id/target/meaning
- `old_items`: 3–5 个
- `content_level`
- `recent_read_types`

### 输出核心结构

```json
{
  "title": "...",
  "type": "story",
  "body": "...",
  "coverage": [
    {"learning_item_id": "...", "surface_form": "wore me down"}
  ]
}
```

### 强约束

- 180–400 英文词。
- focus item 必须自然出现；允许正常词形变化或 chunk 的自然实现。
- old item 能自然融入才使用，不为塞词破坏文章。
- 正文整体难度接近 content_level。
- `body` 是纯文本段落，不输出 HTML。
- 输出只含 `title`/`type`/`body`/`coverage`；不得输出 `checks` 或任何其他字段。
- 后端必须检查 focus coverage；缺失则拒绝该结果或重试。
- Read 不改变 Stage、排期或 Today 任务，这是后端硬规则。

## 12. judge_duplicate_meaning

### 输入

- existing item
- candidate item

### 输出

```json
{
  "decision": "merge",
  "confidence": 0.91,
  "reason": "两个 meaning 都表示长期压力造成逐渐消耗；来源例句不同但义项相同。"
}
```

`decision` 只能是：

- `merge`：同 target、同义项，可合并例句/来源；
- `new_item`：同 target 但学习义项明显不同；
- `skip_exact_duplicate`：内容本质完全重复。

AI 只给建议，Import Preview 中的最终决定仍由用户确认。

## 13. Prompt Eval

### 13.1 目的

Prompt 的优化必须可复现。以后用户让 Coding Agent “把批改调宽松一点”“减少烂填空题”“让 Read 更自然”时，Agent 应先在固定案例上比较旧版和新版，而不是直接凭感觉修改。

### 13.2 Fixtures

至少覆盖：

- Production：自然正确、正确但有别的地道说法、轻微语法错、目标义项误用、漏 target、只存在标点/大小写问题。
- Production 题目生成（generate_production_prompt）：中文题干明确单一、must_use 等于 target、reference_answer 使用当前义项、题干不泄露英文答案。
- Understanding：不同词性、易混 meaning、chunk、source/new context。
- Cloze 生成：词形变化、chunk、多解风险。
- Cloze 判定：合理词形应接受、同义词替代应拒绝、拼写错误边界。
- Read：focus coverage、难度、自然度、旧词可选融入。
- Duplicate：同义项不同来源、同 target 不同义项、完全重复。

### 13.3 修改流程

1. 修改对应 Prompt Markdown。
2. 对相同 fixtures 跑当前版与候选版。
3. 机器检查 Schema 和硬约束。
4. 输出 changed cases，重点审阅差异。
5. 回归满足预期后 `version + 1`。
6. 提交 Prompt、必要的 fixture 更新和简短 Eval 摘要。

如果为了通过 Eval 而修改 fixture 的“期望结果”，必须说明业务理由；不能通过改答案掩盖 Prompt 回归。

## 14. AI 失败降级

- 预生成失败 + 有库存：继续学习，不打断用户。
- 预生成失败 + 无库存：允许懒生成。
- 懒生成仍失败：显示“暂时无法生成新题，请稍后重试”。
- Production 批改失败：保存用户输入，允许重试，不推进 Stage。
- Read 失败：不影响 Today 完成状态。
- Prompt 加载/校验失败：服务启动失败，不能静默退回未知旧 Prompt。
