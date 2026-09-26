# 手动下一题统一 + 会话列表只读 + 完成页今日回顾 — 设计

日期：2026-09-26 晚（用户第三轮验收反馈）

## 背景

用户完成首日学习后提出：① 学完后无法回看今天学的词条、无法再复习；② 会话列表"跳做未完成任务"与按到期调度的复习心智不符（SR 类 app 通常线性推进）；③ 答对的 4 秒自动跳题不统一，希望与答错一样手动点"下一题"。

## 改动

### A. 答对手动"下一题"（删除自动跳题，Today 与 Library 练习统一）

- `ChoiceQuestionCard`（Today 与练习共用）：删除 `CountdownLabel`（"下一题 · Ns"视觉倒计时）与答对态"点击任意处继续"（根节点 onClick）；答对态改为与答错同构——反馈 chips（其实是蒙的/太简单了）+ 右侧 `下一题` 按钮。
- `ActiveSession`：删除自动跳题 effect、`armedRef` 及 unmount 重置、hold 机制（`onHoldChange` 全链路含 TaskCard Props）、`MANUAL_ADVANCE_TYPES`、`CORRECT_AUTO_ADVANCE_MS` import/re-export。
- `PracticeView`（Library 练习）：删除选择题答对自动推进 effect 与 `CORRECT_AUTO_ADVANCE_MS` import。
- `apps/web/src/lib/questions.ts` 的 `CORRECT_AUTO_ADVANCE_MS` 常量删除（全库仅上述两处消费）。

### B. 会话列表降级只读（删除跳做）

- `ProgressRow` 列表条目：未做（无结果且非当前）置灰不可点，与已撤销同样 `disabled`；已完成可点回看；"当前"可点回当前（回看退出唯一路径）。
- `ActiveSession`：`reviewing` 简化为 `cursor !== null`（cursor 只可能指向已完成条目）；跳做可作答分支随之消失，注释同步。

### C. 完成页"今日回顾"（只读列表）

- `CompletedToday` 在摘要下方渲染当天会话任务列表（`GET /api/today/tasks`，完成后仍返回当天 session）。
- 排序：答错在前、答对次之、已撤销最后；每行显示词条/题型/对错（或"已撤销"），点击跳 `/library/:itemId`（详情页含"练一下"入口——再复习走练习模式，不影响正式进度）。
- 不提供当天重答（保持间隔调度纯净）。

## 测试

- 单测：today-navigation 删除两个倒计时用例，新增"答对显示下一题按钮点击推进"；跳做用例改为"未做条目置灰不可点"；新增 completed-today.test.tsx（排序/链接/已撤销标注）。
- e2e：`continueAfterCorrect` 改为点"下一题"按钮；"导航"用例的跳做段改为断言 stable 条目 disabled；主流程完成摘要后断言回顾列表可见且含答错的 stable。

## 明确不做

- 不加当天重答/再来一轮（间隔调度不动）。
- 不改调度算法、题型分配。
- 坏题确认框保留（onHoldChange 删除后其自身交互不变）。
