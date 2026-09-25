# DATABASE.md — English Learning Tool V1.2

> 目标：用最少、清晰、可迁移的表结构承载 PRODUCT_DESIGN.md 中的业务真相。SQLite + Drizzle ORM。字段名建议数据库使用 `snake_case`，TypeScript 层映射为 `camelCase`。

## 1. 全局约束

- `PRAGMA foreign_keys = ON`
- 建议 `journal_mode = WAL`
- 所有时间存 UTC ISO / integer timestamp，应用层统一转换
- Learning Item 不物理删除；用户删除语义使用 `archived`
- AI 派生数据可清理；核心学习数据长期保留
- 所有 review state 改动只通过 review service + transaction

## 2. learning_items

核心学习项。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text/uuid | PK |
| type | text | `word` / `chunk` |
| target | text | 学习目标 |
| meaning | text | 当前实际学习义项 |
| ipa | text nullable | 仅 word |
| source | text nullable | 如 `Avatar S01E12` |
| source_url | text nullable | 来源 URL |
| tags_json | text | JSON array；V1.2 不单独建 tag 表 |
| notes | text nullable | 备注 |
| status | text | `active` / `mastered` / `paused` / `archived` |
| queue_state | text | `new` / `started`；mastered 等仍由 status 表示 |
| needs_reinforcement | integer | 0/1；Read 答错等弱信号 |
| created_at | datetime | |
| updated_at | datetime | |
| archived_at | datetime nullable | |

索引建议：`status`、`queue_state`、`created_at`；target 使用普通索引并由应用层做模糊搜索策略。

## 3. learning_examples

长期例句统一表。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text/uuid | PK |
| learning_item_id | FK | → learning_items |
| kind | text | `source` / `extra` / `personal` |
| text | text | corrected 后长期文本 |
| original_text | text nullable | personal 原始用户输入 |
| better_text | text nullable | 可选润色版本 |
| pinned | integer | 仅 personal 有效 |
| quality_score | real nullable | 自动替换参考；不对用户展示 |
| sort_order | integer | source=0；extra/personal 各自排序 |
| created_at | datetime | |
| updated_at | datetime | |

约束：每个 Item 恰好 1 条 `source`；`personal` 最多 3 条，由 service 保证；pinned personal 不得自动删除。

## 4. review_states

Understanding / Production 共用一张表，每个 Item 两行。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text/uuid | PK |
| learning_item_id | FK | |
| dimension | text | `understanding` / `production` |
| level | integer | 1..7；未激活可为 0 |
| stable | integer | 0/1 |
| next_review_at | datetime nullable | 未激活时可空 |
| last_review_at | datetime nullable | |
| correct_streak | integer | 可选统计 |
| wrong_streak | integer | 可选统计 |
| updated_at | datetime | |

唯一约束：`(learning_item_id, dimension)`。

## 5. review_sessions

正式 Today Session。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text/uuid | PK |
| session_date | text | 用户本地日期 `YYYY-MM-DD` |
| started_at | datetime | |
| completed_at | datetime nullable | |
| base_task_count | integer | Session 创建时基础任务数 |
| new_items_started | integer | 当天已启动新项数 |
| created_at | datetime | |

V1.2 单用户，因此 `session_date` 可唯一。

## 6. review_tasks

Session 中的任务实例。Question 是可复用题库；Task 是一次正式呈现。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text/uuid | PK |
| session_id | FK | |
| learning_item_id | FK | |
| dimension | text | U / P |
| question_id | FK nullable | Learn 首题或特殊任务可按实现决定 |
| task_type | text | `understanding` / `cloze` / `production` / `learn` |
| origin | text | `base` / `reinforcement` / `read_reinforcement` |
| sort_key | real/int | 队列排序 |
| defer_count | integer | later 次数 |
| completed_at | datetime nullable | 幂等关键字段 |
| canceled_at | datetime nullable | 坏题撤销等 |
| created_at | datetime | |

索引：`session_id, sort_key`；`learning_item_id, origin`。

## 7. questions

可再生 AI 题库。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text/uuid | PK |
| learning_item_id | FK | |
| type | text | `understanding` / `cloze` / `production` |
| status | text | `fresh` / `active` / `retired` / `bad_question` |
| meaning_snapshot | text | 防止题义漂移 |
| prompt_text | text nullable | 表达题中文提示等 |
| context_text | text nullable | 新上下文 |
| payload_json | text | options、accepted forms、规则等 |
| correct_option_id | text nullable | 选择题；展示顺序不落库 |
| prompt_key | text | 如 `generate_cloze`。 |
| prompt_version | integer | Prompt frontmatter 版本。 |
| prompt_hash | text | 实际模板 SHA-256，用于精确追溯。 |
| model | text | |
| use_count | integer | |
| correct_count | integer | |
| last_used_at | datetime nullable | |
| retired_at | datetime nullable | |
| created_at | datetime | |

`bad_question` 30 天后可删；`retired` 45 天后且库存充足可删。

## 8. attempts

所有正式答题与 Library practice 的作答历史。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text/uuid | PK |
| review_task_id | FK nullable | Library practice 时为空 |
| learning_item_id | FK | |
| question_id | FK nullable | |
| mode | text | `today` / `library_practice` / `read_check` |
| answer_text | text nullable | |
| selected_option_id | text nullable | |
| result | text | `pass` / `basic_pass` / `fail` / `void` |
| viewed_source | integer | |
| feedback | text nullable | `guessed` / `too_easy` 等 |
| correction_json | text nullable | expression diff |
| explanation | text nullable | |
| better_version | text nullable | |
| ai_prompt_key | text nullable | AI 实时判定时使用，例如 `check_production` 或 `check_cloze`。 |
| ai_prompt_version | integer nullable | |
| ai_prompt_hash | text nullable | |
| ai_model | text nullable | |
| pre_state_json | text nullable | Today 正式结算前状态快照，支持坏题撤销 |
| post_state_json | text nullable | |
| created_at | datetime | |
| voided_at | datetime nullable | 👎 后撤销 |

每个 Item 近期表达历史最多保留 10 次；进入 personal example 的内容由 learning_examples 长期保留。

## 9. read_articles

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text/uuid | PK |
| title | text | |
| type | text | story / daily_scene / knowledge / short_opinion（Phase 5 工程补齐） |
| body | text | |
| content_level | text | 默认 B1 |
| favorite | integer | |
| checks_json | text | 检查题存储（Phase 5 工程补齐）：[{id, learningItemId, question, options, correctOptionId, answered?}]；correctOptionId 仅服务端判定用，不返回前端 |
| prompt_key | text | `generate_read`。 |
| prompt_version | integer | Prompt frontmatter 版本。 |
| prompt_hash | text | Prompt 模板文件 SHA-256，用于精确追溯。 |
| model | text | |
| created_at | datetime | |
| expires_at | datetime nullable | 普通文章 30 天 |

## 10. read_article_items

记录某篇 Read 使用了哪些学习项。

| 字段 | 类型 | 说明 |
|---|---|---|
| read_article_id | FK | |
| learning_item_id | FK | |
| role | text | `focus` / `old` |
| highlighted | integer | focus=1，old=0 |
| surface_form | text nullable | focus 项在正文中的实际形式（AI coverage 持久化，Phase 5 工程补齐）；old 为 null |

联合主键或唯一约束 `(read_article_id, learning_item_id)`。

## 11. settings

单用户 key-value 或单行设置表均可。推荐单行明确字段：

- `max_new_items_per_day` = 10
- `content_level` = `B1`
- `preferred_tts_voice` nullable
- `updated_at`

## 11A. daily_stats（工程补齐：长期聚合统计）

PRODUCT_DESIGN 10.3 要求“明细学习日志 60 天；长期只保留聚合统计”，且 12 个月热力图需要 ≥12 个月的每日数据，因此需要一张每日聚合表。该表在任务结算事务内 upsert，并包含在完整备份 JSON 中。

| 字段 | 类型 | 说明 |
|---|---|---|
| date | text | PK；`YYYY-MM-DD`，按 APP_TIMEZONE 归属 |
| formal_tasks_completed | integer | 当天完成的正式 Today 任务数（热力图 / 最近 7 天） |
| new_items_started | integer | 当天完成的 Learn 任务数（每日额度统计） |
| production_attempts | integer | 当天表达题作答数 |
| production_pass | integer | 当天表达题 pass 数 |
| updated_at | datetime | |

> `preferred_tts_voice` 因浏览器 voice 集合因设备而异，实际选择存前端 localStorage；该字段仅作保留/提示用途，V1.2 不作为跨设备配置。

## 12. schema 变更规则

1. 所有表结构变更通过 Drizzle migration。
2. 新增字段前先判断它是核心长期数据还是可再生派生数据。
3. 产品规则变化先改 PRODUCT_DESIGN.md，再改 DATABASE.md 和代码。
4. 禁止为了“以后可能用”提前引入 tag 关系表、事件溯源、向量字段、JSON 大杂烩主表。


## 13. Prompt 数据边界

Prompt 正文**不进入数据库**。数据库仅保存某次 AI 产物所使用的 `prompt_key / prompt_version / prompt_hash / model`。其中 `prompt_hash` 指 Prompt 模板文件本身的 hash，而不是包含本次用户输入的渲染后内容 hash。

原因：

- Prompt 与代码、Zod Schema、Eval Case 强关联，应由 Git 一起版本化；
- Coding Agent 可以直接 diff、修改和回滚 Markdown Prompt；
- 避免建设没有必要的 Prompt 管理后台；
- 防止数据库 Prompt 与代码 Schema 产生版本漂移。

如后续确有在线 A/B Prompt 管理需求，应先形成真实痛点，再单独评审；V1.2 不提前设计。
