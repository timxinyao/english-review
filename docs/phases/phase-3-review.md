# Phase 3 — 复习引擎与 Today（理解 + 填空）

**状态：done · 2026-09-24 完成**（三并行子 agent：后端核心 review+questions、后端 today 会话域、前端 Today；GLM-5.3-Flash）

## 目标

核心学习循环跑通：Today 开始/恢复 → Learn 卡 → 理解题/填空题作答 → 状态机推进 → 补强 → later → 完成摘要；题目预生成 + 懒生成；幂等与并发安全。

## 实际交付

**后端核心（review + questions + job）**
- `modules/review/service.ts`：纯函数状态机（computeNextReviewState：pass/basic_pass/fail/too_easy 全规则、常量取自 shared）、learn 激活（U=L1+1d / P=L0+1d）、isMastered、advanceReviewState（事务内读-算-写 + 双维 stable→mastered）、listUpcomingDue。
- `modules/questions/service.ts`：acquireQuestion（最旧优先 + 置 active/计数）、generateQuestionsForItem（AI 生成→Schema→入库含 prompt 元数据）、evaluateChoice、evaluateCloze（本地归一化判定 + AI 兜底可注入）、countQuestionStock。
- `src/jobs/daily-prefetch.ts` + `pnpm --filter @el/api job:prefetch`：48h 窗口按目标库存补差，单条失败不中断，失败数>0 退出码非 0。

**后端 today 会话域**
- `GET /api/today` 三态（idle：dueItems/newTodayAvailable/recentlyLearned；active：progress+currentTask；completed：summary）
- `POST /start`：幂等；到期维度任务 + New Queue Learn；取题/懒生成在事务外；混排（同 item 不相邻、同题型连续≤3）
- `POST /tasks/:id/answer`：幂等（alreadyCompleted 回放）、同步事务结算、learn 双维激活 + queue_state + daily_stats、补强插入（≤2/项，位置 max(当前+3, 后 30%)+0.5）、attempt pre/post 快照（含 reinforcementTaskIds）、完成检测与 summary（recommendRead=存在 fail）
- `later`（移尾不写 attempt）、`bad-question`（快照回滚 + 补强取消 + stats 回减 + 后续作答 409）、`feedback`（guessed 从 pre 重算降级 / too_easy 额外升 1，仅非 learn 最新 attempt 一次）
- `scripts/e2e-server.ts` E2E_SEED=1 确定性播种（5 项：4 到期 + 1 New Queue）

**前端 Today**
- idle 卡 / active 会话（细进度条、Learn 卡含 TTS、选择题 shuffle+2s 自动下一题+查看原句+蒙的/太简单、填空内嵌输入、稍后再做、👎 坏题 confirm）/ completed 摘要 + recommendRead 提示；`lib/tts.ts`（en-US 优先）

## 完成标准核验

- [x] 状态机全结果矩阵、mastered、幂等/并发（重复提交不重复结算）、New Queue 额度跨日、补强上限与位置、later、坏题撤销（含 learn 撤销）、cloze 本地+AI 兜底、库存与懒生成、shuffle 提交 option id —— 全部有测试
- [x] 时间偏移模拟多日调度经单测验证（固定 now 断言 next_review_at）
- [x] `pnpm lint && pnpm typecheck && pnpm test` 全绿（api 223 + web 45）
- [x] E2E 9/9（含 idle→开始→Learn+选择/填空/稍后/答错→补强→完成摘要全流程，连跑 3 次稳定）
- [x] 真实服务 HTTP 全链路冒烟（learn 答对→L5→L6、next+60d、快照落库）

## 决策记录

- **stable 维度 nextReviewAt=null（吸收态）**：调度查询按 `next_review_at <= now` 天然排除；too_easy 不提前 stable（仅 L7 到期再 pass 触发）。
- fail 的 L0 输入按 `max(level-1,1)` 落为 L1（失败也激活）；initialUnderstanding 的 correctStreak=1。
- cloze 的 `payload_json.acceptedAnswers[0]` 恒为标准答案（canonical 与 checkCloze 的 answer 变量）。
- **prefetch job 生产守卫**：无 GLM key 时拒绝预生成并退出非 0，防止 mock 输出污染生产题库。
- start 幂等含"当日已完成 session → 返回 completed"；额度内生成失败项不回填后续候选（严格取 min 后逐项跳过）。
- learn 答错同样占额度、置 queue_state=started 并插补强（"答错不激活走补强"）。
- 空会话（无到期无可学）自动 completed，避免不可完成的 0/0 会话。
- TodayTaskView.sourceExample 对所有任务返回（默认隐藏是前端行为）；supplementaryExamples 仅 learn 给 1 条。
- feedback 的 guessed 实现"恢复该维度 pre 快照再以 fail advance"，并补偿 mastered 回退。
- today service 依赖注入（TodayDeps + setTodayDepsForTests + 动态 import 真实绑定）保证核心逻辑全量单测不依赖并行进度。
- 前端：mock 桩落在 lib/api 层（保留真实 mutation/invalidate 行为）；shuffle 以 questionId 为种子（跨 remount 稳定）；answeredTaskIds 守卫防 refetch 竞态重复作答；最后一题答错时反馈冻结不跳完成页。
- **协调者修正**：`newTodayAvailable = min(剩余额度, New Queue 候选数)`（PRODUCT §5.1 "N new today" 语义：实际会引入数，非裸额度）。

## 遗留问题（移交后续阶段）

- evaluateCloze 未返回 prompt 追溯元数据 → AI 兜底 attempt 的 ai_prompt_* 暂为 null（Phase 4 接 check_production 元数据时顺带补）。
- QUESTION_MAX_STOCK 超库存 retire 未实现 → Phase 6 weekly-cleanup。
- daily_stats.production_attempts/pass 未写（Phase 4 表达题接入时）。
- GLM_API_KEY 配置后：跑真实 ai:eval、实测懒生成/补强 AI 路径、prefetch job 真实运行。

## 变更日志

- 2026-09-24：三个子 agent 并行交付（后端核心 66 测试 / today 71 测试 / 前端 18 测试）；协调者修复 newTodayAvailable 语义并同步 3 处测试断言；全部门禁与 E2E 通过。
