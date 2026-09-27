# 同日追加学习（再学一批）— 设计

日期：2026-09-27（用户确认：当天提高额度后希望能继续多学）

## 需求

今日会话已完成且新学额度有剩余时，完成页提供"再学 N 个新词"按钮：向当天会话追加一批 Learn 任务并重新激活会话。额度改动即时生效（剩余 = maxNew − 今日已学）。

## 改动

### API

1. `POST /api/today/extend`（新端点，持 question-generation 锁）：
   - 校验：今日 session 存在且 `completedAt !== null`（未完成/不存在 → CONFLICT）；剩余额度 > 0（否则 CONFLICT 今日额度已用完）。
   - 取词：与 start 同序（queue_state='new'，active，createdAt,id），`slice(0, 剩余额度)`；不限制模式按批 10 个。
   - 逐词 `acquireWithGenerate('understanding')`（失败跳过不占额度，warn 日志）。
   - 事务：追加 reviewTasks（sortKey 接当日最大值递增，taskType 'learn'，origin 'base'）并清空 session.completedAt；返回 `TodayActiveResponse`。
   - 空 New Queue → CONFLICT（无新词可学）。
2. `TodayCompletedResponse` 增 `remainingNewQuota: z.number().int().nullable()`（null=不限制；completed 分支由 maxNew − dailyStats(今日).newItemsStarted 计算）。

### Web

- `CompletedToday`：`remainingNewQuota` 为 null 或 > 0 时显示按钮——有限："再学 N 个新词"；不限："再学 10 个新词"。点击 → `POST /today/extend`（新 hook）→ invalidate today → 回 active 会话（自动发音/列表/下一题等既有机制全兼容）。
- 失败（CONFLICT 等）沿用既有错误展示（按钮下方错误文案，无弹窗体系）。

### 不变

startTodaySession 幂等/调度/补强/统计/热力图（追加任务与正常 Learn 完全同路径）；预取（全量备货已覆盖）。PRODUCT §3.4/§4.3 补"同日追加"说明。

## 测试

- API：extend 成功（额度/取词/清 completedAt/ActiveResponse 返回）、未完成 CONFLICT、额度用尽 CONFLICT、不限批 10、幂等不重复、completed 响应 remainingNewQuota 三态（剩余/null 不限/0）。
- Web：按钮显示条件三态、点击调用与错误展示。
- e2e：完成→再学一批→新 Learn 卡出现→做完再完成。

## 明确不做

- 不做"指定追加数量"（按剩余额度整批/不限固定 10）。
- 不改跨天未完成会话的既有行为。
