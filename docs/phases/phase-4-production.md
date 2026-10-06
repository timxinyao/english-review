# Phase 4 — 表达与个人例句（Production + Practice）

**状态：done · 2026-09-24 完成**（两并行子 agent：后端 / 前端；GLM-5.3-Flash。子 agent 会话中途被取消，但交付已完成，由协调者集成验证）

## 目标

主动输出闭环：表达题生成（受控中文提示）、实时 AI 批改（三档判定 + 最小纠错 diff + 可选 better version）、Personal Example 沉淀（≤3、pinned 保护、自动替换）、Library"练一下"。

## 实际交付

**后端**
- `modules/questions`：generateQuestionsForItem 支持 production（单题结构 → prompt_text=zh_prompt、payload 含 referenceAnswer/acceptanceNotes）；`evaluateProduction`（check_production 实时调用，变量组装按 prompt 文件，返回含 promptMeta——补齐 Phase 3 遗留的批改追溯）；acquireQuestion/countQuestionStock 支持 production；prefetch 对 P-L3+ 补 production 库存。
- `modules/today`：P 维度题型映射（L1-2 cloze / L3 哈希奇偶 mixed / L4+ production）；production answer 路径（批改事务外、失败零写入 502；fail 不插补强；correction/explanation/better/ai_prompt_* 落 attempt；幂等回放 correction；daily_stats.production_attempts/pass；造句历史裁剪至 10 条）；bad-question 撤销联动删除本次 personal example（pinned 例外）；feedback 拒绝 production 任务。
- `modules/learning-items`：`maybeSavePersonalExample`（result≠fail 且 eligible；≤3；替换规则 新分 > 最差 unpinned +0.1；pinned 永不淘汰）；detail 增加 productionHistory（最新 10 条倒序）。
- `modules/practice`（新建）：start（按当前阶段组 3 题、优先库存）+ answer（**零状态影响**：不改 review_states/next_review_at/status、不造补强、不写 daily_stats；attempt mode=library_practice；production 走批改 + personal 沉淀）。
- `e2e-server`：give up（U stable + P-L4 due）production 种子、确定性 fake 批改注入（today + practice）、`POST /api/__e2e/reset` 测试重置端点。

**前端**
- `components/correction-diff.tsx`（全局：红删除线/绿新增，better_version 折叠）+ choice/cloze/production 题卡组件提升到 components/（Today 与练一下复用）。
- Today production 卡：中文提示 + mustUse 高亮 + textarea + 批改中状态 + 三档判定 + diff + "已存入个人例句"提示 + 手动下一题 + 批改失败保留输入可重试。
- Library 详情：造句历史区块（corrected 主体 + 原句对照 + result 标签 + better）、"练一下"视图（3 题、进度、完成后返回）。

## 完成标准核验

- [x] check_production Schema 与 segments 重建校验（completeStructured 不变式 + 274 用例含矩阵）
- [x] 批改失败不推进 Stage、保留输入（后端零写入 + 前端重试，均有测试）
- [x] Personal Example：仅 result≠fail 且 eligible 入库、上限 3、替换规则、pinned 保护（单测覆盖全分支）
- [x] practice 零状态影响断言 + 表达句仍可沉淀 personal
- [x] 造句历史每项 10 条裁剪
- [x] E2E：表达题提交 → 通过 + diff + 已存个人例句；详情历史与个人例句；练一下全流程 —— **12/12 全绿**（auth 4 + library 4 + production 3 + today 1）
- [x] `pnpm lint && pnpm typecheck && pnpm test` 全绿（api 274 + web 64）
- [x] check_production 真实模型 Eval：**2026-09-25 完成**——GLM 接入切换为 Anthropic 兼容端点后全量 7 任务 20/20 通过（glm-5.3 判定 / glm-5.3-flash 生成），真实基线已存 baselines/

## 决策记录

- P-L3 mixed 用 itemId 哈希奇偶决定 cloze/production（确定性、可测试）。
- 表达题 fail **不插补强**（PRODUCT 7.6"不强制当天重做"）。
- bad-question 撤销时删除该次写入的 personal example（pinned 例外）——个人例句虽是长期资产，但坏题撤销语义是"消除该题造成的学习影响"。
- 造句历史裁剪在写入时执行（保留最新 10 条，不区分 voided；已入 personal example 的内容由 learning_examples 长期保留，attempt 行可删）。
- practice 题目复用 questions 正常库存（合法可再生缓存），不足且 AI 可用才补生成。
- 跨 feature 的题卡渲染组件提升至 `apps/web/src/components/`（choice/cloze/production-question-card + correction-diff + question-answer 工具），遵循 ARCHITECTURE 跨 feature 升级规则。
- e2e 新增 `POST /api/__e2e/reset`（仅 E2E_SEED=1 注册、需登录会话）：多个"完整会话"spec 共享 e2e.db 而一天只允许一个正式 session，各 spec 开头重置回种子态，保证顺序无关。
- fake 批改仅注入 e2e-server（测试进程），生产路径无任何 mock 语言判定。
- 批改 v2 后续决策（2026-10-04）：corrected 仅做必要语法/拼写/明显搭配修正；评分以用户原文为准；更自然版本区分沿句 polish 与 rewrite 参考表达。个人例句明确指定 corrected/better 实际来源，better 仅允许 polish；候选质量必须评价最终保存文本，旧历史不回填、不重新批改，现有数据库结构不加列。
- 批改 v2 语言边界（2026-10-04）：polish 可调整意思等价的量词、单复数和句式以符合自然表达，不机械保留不地道的称呼；corrected 仍优先保持原句架。原文已自然不强制生成润色；候选优先合格 polish，rewrite 与纠正后的独立合格候选分开处理。
- 存量维护范围扩大（2026-10-05）：用户明确要求全量人工校对，故允许一次性修订存量批改及关联个人例句，覆盖此前“本次只更新新答案”的范围。默认保留历史评分、进度、统计和原模型元数据；人工记录另存 JSON，执行前整库备份及原行比较，固定／正文已编辑项保护。正式 API 不支持历史批改编辑，因此本次用离线维护脚本事务化处理，不新增产品入口或 API，不修改 Prompt。

## 遗留问题（移交后续阶段）

- ~~GLM_API_KEY 配置后：跑 `pnpm ai:eval -- --all` 出真实基线~~（2026-09-25 完成，见完成标准）
- evaluateCloze（AI 兜底路径）的 attempt ai_prompt_* 仍为 null（仅 check_production 已补）。
- personal example 替换/淘汰的更细质量策略（如长期未使用的 unpinned 低分项）留待真实使用后评估。

## 变更日志

- 2026-09-24：双子 agent 并行交付（子 agent 会话被取消但工作树已完成）；协调者集成：清理残留进程、修复 today.spec 过时断言（4→5 due、补表达卡分支）、新增 e2e reset 端点解决 spec 间 session 冲突；全部门禁与 12 个 E2E 通过。
- 2026-09-25：GLM 接入切换为 Anthropic Messages 兼容端点（`/api/anthropic/v1/messages`，x-api-key + anthropic-version，max_tokens 必填，无 response_format——JSON 靠 Prompt 约束 + extractJson 容错）；模型映射更新为 glm-5.3（判定/批改/Read）/ glm-5.3-flash（题目生成）；dotenv 在 index.ts 与 ai-eval.ts 加载（e2e-server 不加载，避免 e2e 触发真实生成）；修复 generate_production_prompt 不变式过严（允许词形变化：target 完整出现或任一组成词≥3字符出现）；真实模型全量 Eval 20/20 通过并保存基线。
- 2026-10-04：GPT-6 Luna max 按已批准的批改与个人例句设计实施 check_production v2、source/kind Schema/API DTO、统一 personal example 插入/替换选择、历史展示标签和精准 undo 保存文本识别；协调者集成、复核并验证。扩充 Production fixtures 至 14 项，Eval 支持保存完整 JSON 审阅报告；相同输入真实模型对比旧版评分 13/14、新版全部断言 14/14，逐句审阅通过，详细结果与取舍见 [发布评测](../evals/2026-10-04-check-production-v2.md)。lint、typecheck、822 项单元／集成测试、30 项 E2E 与独立审阅通过。保留既有工作树，不提交或推送。
- 2026-10-05：按用户授权脚本部署批改 v2 与个人例句更新；API 健康、HTTPS 页面／静态资源与当前构建、运行源码一致性均核验通过，Prompt hash 与发布评测版本相同。上线 JS 为 `index-CVbHK3jY.js`；旧版本备份 `/opt/english-learning/releases/before-production-polish-20261005-054243`。无数据库迁移或历史重新批改，未提交或推送。
- 2026-10-05：按用户后续明确请求完成存量人工校对：10 条造句历史、8 条现有个人例句更新，1 条因“喂狗／养狗”语义差异不合格的个人例句移除，原答案／评分／进度／统计保留。人工复核单独留档，不伪造 Prompt 调用。整库备份、6 项维护测试、v2 契约与 diff 校验、完整副本演练、实际写入逐表验证、10 项 HTTPS API 回看通过；详情见 [人工校对清单](../evals/2026-10-05-production-manual-curation.md)。无应用源码修改、数据库迁移或新 API，未提交或推送。
