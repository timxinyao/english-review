# 题目生成全局锁 + 预取覆盖新词 + 开始等待弹窗 — 设计

日期：2026-09-27（"正在开始"卡 48 秒问题的根治方案，用户追加锁与弹窗需求）

## 背景

`POST /api/today/start` 首次点击耗时 48 秒：凌晨预取任务只覆盖"到期复习"维度，新词队列（每日新学额度内的 Learn 题）由 start 在线串行调用 GLM 生成（每题约 4~5 秒 × 10）。用户追加要求：① 生成需全局锁，避免 start × 预取 × 练习等并发生成冲突/重复；② 已在生成时前端弹窗提示等待。

## 改动

### A. 跨进程全局生成锁（job_locks 表 + withJobLock）

- 新表 `job_locks(name PK, holder, lease_until)`（drizzle-kit 生成迁移，启动时 runMigrations 自动执行）。
- `apps/api/src/db/job-lock.ts` 导出 `withJobLock<T>(db, name, fn, { ttlMs=10min, waitTimeoutMs=180s, pollMs=300ms })`：better-sqlite3 同步事务内抢租约（空位或 `lease_until <= now` 视为崩溃残留可抢占；跨进程写锁竞争 SQLITE_BUSY 按未获取处理下轮重试），拿不到则轮询等待；fn 完成后仅当 holder 匹配才释放。超时抛 `JobLockTimeoutError`。（实施修订：预取调用点租约加长为 15min——unlimited 大积压串行生成可达约 60 次调用。）
- 锁名 `question-generation`，消费点三处：`startTodaySession` 规划段、`runPrefetch`、`startLibraryPractice`。入口持锁、内部实现（acquireWithGenerate 等）不重复加锁，无重入死锁。

### B. start 生成并发 3（保序）

- `today/service.ts` 新增 `mapLimit(items, limit, fn)`：保序并发映射。
- dueRows 段：先按 itemId 分组（同 item 的 U/P 维度串行，防止并发取到同题），组间并发 3；learn 段（item 唯一）直接并发 3。plans 顺序与原串行实现一致（sortKey 语义不变）。
- 常量 `GENERATION_CONCURRENCY = 3`。

### C. start 并发安全（三层）

- 进程内：`startTodaySession` 以 promise 链串行化（双击/多标签同进程）。
- 跨进程：`uq_review_sessions_date` 唯一索引（已存在）兜底——insert 冲突 catch 后重读当日 session 返回 active 态。
- 生成互斥：A 的全局锁。

### D. 预取覆盖新词队列

- `runPrefetch` 在到期维度之后：取 `queueState='new'`（active，按 createdAt,id 序）前 `min(今日剩余新学额度, 20)` 项（额度 = `maxNewItemsPerDay - dailyStats(今日).newItemsStarted`；unlimited 上限 20），为每项补 understanding 库存至 `QUESTION_TARGET_STOCK.understanding`(3)。
- `PrefetchSummary` 增加 `newItems` / `newGenerated`，日志同步输出。

### E. 前端等待弹窗

- `IdleToday` 开始期间（`start.isPending`）：portal 到 body 的弹窗（`z-overlay`，遵守 DEVELOPMENT §7 层叠规则）——"正在准备今日题目…（首次生成约需一分钟，请保持页面打开）"；锁排队期间同一弹窗覆盖（后端等待不返回）。
- 失败（含锁等待超时 409）：弹窗显示错误信息 + 关闭/重试（重试 = 再次 mutate）。

## 错误处理

- `JobLockTimeoutError` 映射 `appError('CONFLICT', '题目正在准备中，请稍候重试')`。
- 生成失败沿用现状：跳过该任务/项不占额度，warn 日志。
- 双进程同时 start：一方正常建 session，另一方靠唯一索引兜底返回既有 active。

## 测试

- 单测 `job-lock.test.ts`：抢占、等待串行、租约过期接管、holder 匹配释放。
- 单测 `daily-prefetch.test.ts` 扩展：新词库存不足→生成、额度为 0→跳过、unlimited→上限 20、持锁执行。
- 集成 `today.test.ts`：新词生成并发下 plans 顺序保持；start 持锁（锁占用时等待）。
- web 单测：弹窗 pending 文案（portal 挂 body）、错误 + 重试回调。

## 明确不做

- 不做锁租约续期（ttl 10 分钟远超单次生成时长；崩溃残留由过期接管兜底）。
- 不做生成进度百分比（无可靠进度源，弹窗用静态文案）。
- 不改题库目标存量与调度算法。
