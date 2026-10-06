# DATABASE.md — English Learning Tool V2

> V2 数据契约：`learning_items.production_enabled_override INTEGER NULL CHECK (production_enabled_override IN (0,1) OR production_enabled_override IS NULL)`。NULL 随类型默认（word=0，chunk=1），0/1 为显式关闭/开启；有效值由 review service 计算而非另存。迁移现有行默认 NULL。mastered 依据 U 稳定且（无需 P 或 P 稳定）；paused/archived 不因重算改变。旧 P 排期的 L0 重置、旧 Read reinforcement 清理、切换日和旧备份恢复由 Phase 9 的一次性版本迁移处理，历史不删除。V2 新任务类型为 Recall/Production；cloze 与 Read checks 字段仅为历史兼容保留，不再分配或生成。

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
| production_enabled_override | integer nullable | 0/1 显式关闭/开启，NULL 按类型默认；CHECK 限定三态 |
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
| text | text | 实际进入长期库的 corrected 或 polish 版本，由批改候选 source 明确选择 |
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
| difficulty | real nullable | FSRS 难度 D；NULL=未激活（承接原 level=0 语义） |
| stability | real nullable | FSRS 稳定性 S（天）；mastered 判定 S ≥ 120 |
| reps | integer | FSRS 重复次数（Card 跨重启重建所需），NOT NULL 默认 0 |
| lapses | integer | FSRS 遗忘次数，NOT NULL 默认 0 |
| next_review_at | datetime nullable | 未激活时可空 |
| last_review_at | datetime nullable | |
| correct_streak | integer | 可选统计 |
| wrong_streak | integer | 可选统计 |
| updated_at | datetime | |

唯一约束：`(learning_item_id, dimension)`。

2026-10-03 migration 0007：删 `level`、`stable`，加 `difficulty`/`stability`（NULL=未激活）与 `reps`/`lapses`（FSRS Card 状态重建必需，超出原 spec 字面）；既有 D/S 由 attempts 回放或旧备份折算重建。

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

普通撤销保留旧任务的 completed_at 并写 canceled_at，作答记录置 void；重答创建新的任务 id 并排在待答任务之前。production 使用同学习项的新 question_id，其他题型沿用原 question_id（允许 null），不重开原任务或删除撤销历史（2026-10-04）。

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
| feedback | text nullable | `guessed` / `too_easy` / `gave_up` 等；`gave_up` 表示主动不会，和事后人工反馈互斥 |
| correction_json | text nullable | expression diff |
| explanation | text nullable | |
| better_version | text nullable | |
| ai_prompt_key | text nullable | AI 实时判定时使用，例如 `check_production` 或 `check_cloze`。 |
| ai_prompt_version | integer nullable | |
| ai_prompt_hash | text nullable | |
| ai_model | text nullable | |
| pre_state_json | text nullable | Today 正式结算前状态快照，支持坏题撤销；0007 起含 FSRS `difficulty`/`stability`/`reps`/`lapses`，旧快照缺字段时恢复保持现值 |
| post_state_json | text nullable | Today 结算后状态（含 FSRS 四字段）、插入的补强/个人例句，以及普通撤销需恢复的被替换个人例句/被裁剪表达历史快照；仅记录本次变动，不复制整库 |
| created_at | datetime | |
| voided_at | datetime nullable | 坏题或普通撤销后作废 |

`correction_json` 保存表达批改历史：`segments`、`corrected`、`better`、`betterVersionKind`、`personalExampleSource`。新增的 kind/source 描述当前批改与实际选择；旧记录缺少 kind 时 API 返回 null 并沿用历史展示语义，默认不自动推断、回填或重新批改。用户授权的一次人工维护可追加 `manualRevision`，记录复核时间、规则版本/hash、人工判定与候选选择；保留原 `ai_prompt_*`、`ai_model` 与 `attempts.result`，不能把人工校对冒充新模型调用。`post_state_json` 在本次确实保存 Personal Example 时保存 `personalExampleId` 与实际写入的 `personalExampleText`，撤销以该文本精确检查后续编辑；旧快照按原来的插入/替换路径分别解释，不增加数据库列。授权维护更新已保存正文时同步该实际文本，移除不合格个人例句时清除其派生关联，不改快照中的学习状态；维护前后完整行另存可回滚清单。

每个 Item 近期表达历史最多保留 10 次；进入 personal example 的内容由 learning_examples 长期保留。若最新 Today 正式作答触发历史裁剪，需在其可撤销期间保存被裁剪记录的恢复快照；撤销时恢复，确认无需撤销后可丢弃派生快照。

## 9. read_articles

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text/uuid | PK |
| title | text | |
| type | text | story / daily_scene / knowledge / short_opinion（Phase 5 工程补齐） |
| body | text | |
| content_level | text | 默认 B1 |
| favorite | integer | |
| checks_json | text | V1 遗留检查题（Phase 5 工程补齐；V2 起只读、新文章恒为 '[]'）：[{id, learningItemId, question, options, correctOptionId, answered?}]；correctOptionId 仅服务端判定用，未答不下发，已答随只读回放下发 |
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

## 11B. app_metadata（一次性切换标记）

`key` 是主键，`value` 保存切换时间表述（`foxi_v2` 为 APP_TIMEZONE 本地日期；`fsrs` 为 boot 时刻 UTC ISO），`updated_at` 保存 UTC 时间。`foxi_v2` 标记与旧 P 清零、Read reinforcement 标记清理、状态重算位于同一事务；重复启动只读标记，不再改动 V2 进度。`fsrs` 标记（2026-10-03）与历史 attempts 回放重建 D/S、active/mastered 重算位于同一事务，boot 顺序为迁移 → Prompt Registry 校验 → v2 cutover → fsrs cutover → listen；重复启动只读标记，字节级 no-op。完整备份不包含此数据库级标记：恢复 1.2 备份时每次独立执行旧 P 归一化，恢复 2.0 备份则保留 P 状态；旧格式备份（仅 level/stable）恢复按 V1.2 等级折算 D/S（备份不含 attempts，不回放），含 FSRS 字段的 2.0 备份直接精确保留。

## 11C. push_subscriptions（Web Push 订阅，2026-10-05 migration 0008）

造句批改完成通知（TECHNICAL_DESIGN §7.7）的浏览器推送订阅。单用户应用不区分设备，同一 endpoint 重复 subscribe 走 upsert（密钥轮换时刷新）；推送服务返回 404/410（浏览器清数据/卸载）时由发送钩子删除该行。开关初始状态（GET /api/push/status）= 本表是否存在任意行。不包含在用户备份 payload（设备相关，跨实例无意义）。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | text | PK（uuid） |
| endpoint | text | UNIQUE NOT NULL；推送服务订阅 endpoint |
| p256dh | text | NOT NULL；PushSubscription keys.p256dh |
| auth | text | NOT NULL；PushSubscription keys.auth |
| created_at / updated_at | text | NOT NULL；UTC ISO |

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
