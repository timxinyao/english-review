# Phase 5 — Read（上下文复现）

**状态：done · 2026-09-25 完成**（两并行子 agent：后端 / 前端；GLM-5.3-Flash，协调者集成补详情端点）

## 目标

Read 闭环：选词（focus 3–5 弱项 + old 3–5 稳定项）→ 生成 180–400 词短文 → 高亮 focus → 1–2 道轻量检查 → 答错置 needs_reinforcement → 下次 Today 补一题正式复习 → 历史/收藏/30 天过期。

## 实际交付

**后端（modules/read + today 接入）**
- `POST /api/read/generate`：选词 → completeStructured(generateRead)（事务外，失败 502 零落库）→ 事务落库（article + items + checks_json，prompt 元数据、expires=+30d）
- `GET /api/read/history`：过期排除、favorite 筛选、分页、wordCount；`GET /api/read/:id` 详情（历史项回源，协调者集成期补充）
- `POST /api/read/:id/favorite`：收藏=永久（expires null）/取消恢复 +30d；`POST /api/read/:id/check`：对错判定、**错置 needs_reinforcement、对不清旗**、同 checkId 幂等（answered 写回 checks_json）、attempts mode=read_check、零影响 review_states/daily_stats/Today
- today 接入：start 为有旗项建 origin=read_reinforcement 任务（理解选择题、计入正式 progress/stats、每项每 session 1 个、无题跳过）；完成即清旗（对错都清）；bad-question 撤销回滚旗
- invariants：generateRead 增加「surface_form 大小写不敏感出现在正文」校验（违规自动重试）
- e2e-server：fakeGenerateRead 注入（确定性文章 "A Quiet Morning" + 固定检查题）

**前端（features/read）**
- ReadPage：唯一主动作 [生成阅读]（loading/失败重试）、最近 3 篇、History 分页与收藏筛选
- ArticleView：分段正文、focus 高亮（accent-soft，词边界防误标）、重点复现词列表、TTS 朗读、收藏星标（乐观更新）
- 检查题：radio 不 shuffle、一次提交锁定、对错反馈、答错提示"下次 Today 会安排一题复习"
- CompletedToday 的 recommendRead 提示改为 /read 链接

**Schema 变更（migration 0001/0002）**：read_articles 增加 `type`、`checks_json`；read_article_items 增加 `surface_form`（AI coverage 持久化）。DATABASE.md 已同步。

## 完成标准核验

- [x] 字数 180–400、coverage 完整性 + surface_form 实际出现、checks 1–2、选项合法——不变式 + 测试覆盖
- [x] check 答错只置 needs_reinforcement；下次 start 生成 read_reinforcement；完成清旗；bad-question 回滚——注入时钟集成测试（**E2E 时间偏移部分以集成测试替代**，见决策）
- [x] 普通文章 30 天过期、收藏永久；History 分页与筛选
- [x] Read 不影响 Today 完成状态（断言）
- [x] E2E 13/13（新增 read.spec：生成→高亮可见→检查对错→收藏→历史筛选）；`pnpm lint/typecheck/test` 全绿（api 342 + web 87）

## 决策记录

- **选词规则**：focus = active+started 且非两维 stable，按「近 30 天 today fail 数 DESC → P 维 wrong_streak DESC → 激活维 level ASC → lastReviewAt DESC」；old = mastered 或两维 stable，按 lastReviewAt ASC（最久未复习优先）。两维 stable 的 active 项归 old 池（产品语义是"稳定项"）。
- checks 存 `read_articles.checks_json`（correctOptionId 仅服务端持有，视图不返回）；首答结果写回 checks_json.answered 实现幂等 + 重启安全。
- focus 的 surface_form 持久化到 read_article_items（AI coverage 的落地），详情端点直接回放。
- 取消收藏恢复 created+30d（可能立即过期，属预期：收藏是唯一永久途径）。
- read_reinforcement 任务是**正式任务**：推进状态机、计入 progress/daily_stats；完成后无论对错清旗。
- 详情端点 GET /api/read/:id 为集成期补充（契约缺口：历史项隔日回源）；已过期=404 与 history 口径一致。
- E2E 时间偏移场景（次日 Today 补强）由注入时钟的集成测试覆盖，E2E 不做时间旅行。
- 前端高亮：单次正则长词优先 + 词边界（避免 "drawing" 误标 "raw"）；生成响应写入 article 缓存（staleTime Infinity），当日重进不回源。

## 遗留问题（移交后续阶段）

- weekly-cleanup（Phase 6）负责物理删除过期文章（history 只隐藏）。
- Read 真实模型质量评估：GLM key 已配置，`pnpm ai:eval -- --task generateRead` 真实跑通（Phase 4 基线内 1/1）；日常生成质量待实际使用观察。

## 变更日志

- 2026-09-25：双子 agent 并行交付（后端 44 测试 / 前端 20 测试）；协调者集成：补 GET /api/read/:id 详情端点 + surface_form 持久化 migration 0002 + 4 个集成测试；DATABASE/TECHNICAL 文档同步；全量门禁与 E2E 13/13 通过。
