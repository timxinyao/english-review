# Foxi V2 学习流程设计稿

> 2026-09-30。记录已在对话中确认的产品取舍，供审核；尚未实施，也不是对现行 V1.2 文档的静默替换。审核通过后，先同步正式产品/技术/数据/AI 文档与阶段留档，再写实施计划和代码。

## 目标与边界

目标不是「尽量少做题」，而是让每道正式任务对应一种明确、值得练的能力：理解一个表达，以及在需要时把它用进完整句子。学习链路是 **Learn → Recall → 有选择的 Production → Read 中自然复现**。

- Recall 是正式的 Understanding 任务：看 target 和语境，主动想意思，揭晓后自评。想不起来时可用中文选择题作为 Hint；选择题不独立排期，也不假装等同于无提示回忆。
- Production 是正式的输出任务：给出 target 和具体中文语义任务，写/说完整英语句子，由 AI 评估目标表达在语法、搭配和语境中的使用。它不考「从中文猜出哪个英文 target」，target 可见。
- 不再生成或安排填空题。Read 只负责可选的语境输入与复现，不再附带检查题或改变复习排期。
- 保留现有 Today、Library、Read 页面语义；不增加独立 Practice 页面、AI 分类流程或游戏化任务。

## 每个词条的造句目标

词条新增可空的显式覆盖字段 `production_enabled_override: boolean | null`。`null` 表示随类型默认值，`true` / `false` 表示用户明确覆盖。实际目标由服务端统一计算：

```text
effectiveProductionEnabled = override ?? (item.type === "chunk")
```

因此 chunk 默认需要造句，word 默认不需要；导入时可指定覆盖值，Library 中也可随时改为「按类型默认 / 需要造句 / 不需要造句」。不调用 AI 猜测这个目标，也不为已有词条做 AI 全量标记。类型本身并不因覆盖值而改变。

`mastered` 按当前目标计算：不需要造句的词条只看 Understanding 是否稳定；需要造句的词条必须 Understanding 和 Production 都稳定。覆盖值变化后服务端重算 `mastered` / 正式任务资格，但保留两个维度的历史与进度；不能借改目标改写 Stage。已归档或暂停的词条不会因为重算而自动恢复 active。

- 从「不需要」改为「需要」：若 Production 未稳定，原本 mastered 的词条可重新 active；已有 Understanding 进度不清零。正式 Production 最早从下一个 Today 加入，不向当前 Session 中途插题。
- 从「需要」改为「不需要」：当前 Session 尚未回答的 Production 任务立即取消，不计错、不计作废题、不推进 Stage；已回答的尝试与 Production 进度保留。前端刷新任务数，其他设备的旧任务提交由服务端拒绝。
- 再打开 Production：恢复该词条在 V2 中已有的 Production 状态；不会因为先前关闭而从零重启。V2 上线时针对旧版进度的一次性清零另见迁移章节。

## Learn、Today 与排期

Learn 仍展示精确义项、原始语境等必要材料并建立 Understanding 状态。新词条如需 Production，第一次正式造句最早安排在 Learn 后的**下一本地日**，无须先等 Understanding 达到某个等级。其后两个维度独立排期：Understanding 只出 Recall；Production 只出完整句子。

Production 保留现有独立间隔阶梯：**1 / 3 / 7 / 14 / 30 / 60 / 120 天**。通过可推进到更长间隔，`basic_pass` 走较短间隔，失败缩短间隔；不因一次 Production 失败强制在当天重复造句。具体等级转移沿用 review service 的规则，实施时以契约测试固定；AI 只返回评估，不决定 Stage、due date 或 mastered。

Today 显示所有到期任务，不人为设置每日上限或迁移专用限流。没有做完不算失败：未回答任务保持到期，次日本地日建立新 Session 后重新纳入；Today 进度按当天 Session 重新开始。已结算任务只受正常复习排期影响，不因跨日重复结算。所有结算、撤销、坏题回滚仍由后端保证幂等与学习影响的逆转。

Recall 的「不会」应显示本题答案与必要解释；如果进入 Hint 选择题，选错或选择「不认识」后同样标出正确选项和理由。Production 的无法作答/提交后按其本题标准答案或参考表达给反馈。现有统一的底部操作区和撤销图标语义保持，不把旧填空的反馈 UI 带入 V2。

## Library 的「练一下」

「练一下」不凑固定题量：无需 Production 的词条只给一道 Recall；需要 Production 的词条给一道 Recall 加一道完整造句。它是非正式练习，不改变正式 Stage、due date、Today 结算或 mastered。若一道题生成失败，保留可重试状态，不以填空或选择题补位。

## Read 的定位

Read 继续生成和展示可选文章，让已学表达在新语境中出现；不再生成新的检查题，也不因读/不读/读错而调整 Stage 或 Today 排期。文章可展示本次复现的已学表达，但不引入阅读理解考试。旧文章和旧检查作答保留只读历史。切换 V2 时清除旧 Read 检查留下的待处理 `needs_reinforcement` 标记，避免它们继续制造额外 Understanding 任务；正式复习 Stage 不因此改变。

## 导入、修改、导出与备份

导入 JSON 可选携带 `production_enabled_override`。缺省代表沿用类型默认，不等于显式 `false`。新词条保存显式值或 `null`。

重复导入时：

- 未提供该字段，保持已有词条的覆盖值，不因 merge 或 exact duplicate 重设目标。
- 提供了与现值不同的显式值，预览必须指出目标变化并要求用户确认后才修改；即使其他字段完全重复，也不能静默 `skip_exact_duplicate`。
- 提供相同显式值，按现有重复处理；三态比较须区分 `null` 与 `false`。

Library 修改目标、普通导出及完整备份都要保留显式覆盖值。旧版备份没有该字段时按 `null` 导入，继而按词条类型取默认。V2 备份还需保留 V2 Production 状态；恢复旧版备份进入 V2 时必须经过同一套一次性迁移语义，不能把旧版等级当作已完成的 V2 造句。

## 切换日与数据迁移

V2 在下一本地日边界生效，避免当天已打开的 V1.2 Session 中途变题型。生效前的旧 Session 可按旧题和旧评估器完成；跨过边界后，未回答的旧 Session 任务过期，不算失败。旧标签页对过期 Session 的提交、撤销等写操作必须由服务端拒绝，并引导刷新 Today。

迁移要有一次性版本标记，事务化且可重试，不得在重启或并发请求时重复清零。迁移内容：

1. 保留所有 Understanding 状态、已回答尝试、个人例句、现有学习记录与统计。
2. **所有旧词条的 Production 排期从 L0 重来**，不尝试从旧填空/选择题表现推断造句能力。旧尝试仅作历史；对于已经 Learn 且实际需要 Production 的 active 词条，首次 V2 Production 在切换后的 Today 立即到期。New Queue 尚未 Learn 的词条等 Learn 后至少下一本地日。
3. 按当前有效造句目标重算 active/mastered；维持 paused/archived 状态。清除旧 Read reinforcement 待处理标记。
4. 停止把旧 cloze 库存分配给新任务，也停止预生成 cloze；历史题和尝试按正常保留策略可查看，不需要为切换物理删除。

不分批推迟、也不设置每日任务上限。切换日可能有大量到期造句，允许用户分多天完成；不完成没有惩罚。UI 应把总量和当前进度说明清楚，不承诺当天全部做完。

## 按需绑定题目与失败恢复

旧 `startTodaySession` 会在打开 Today 前为所有到期任务获取/生成题目；V2 大量造句到期时，这会把首屏卡在 AI 调用上。新流程先快速建立并返回**所有到期任务及进度**，只对当前题和少量前瞻题按需绑定/生成，后台继续预取。可以短暂显示「正在准备」；不要求全部题生成后才打开 Today。

生成失败或超时只影响该题的可用性：任务仍 pending，不计作答，不降低 Stage，也不从今日总数消失；可重试或稍后再做。前瞻生成失败不能阻塞当前可用题。不能在持有 SQLite 写事务时等待 AI；题目绑定需要并发保护，防止双设备生成/绑定不同题。已有撤销、坏题回滚、题目失效（target/meaning 被改）和单题只结算一次的后端约束继续适用。

## 对现有实现与文档的影响

实施时应先依 AGENTS.md 同步 `docs/PRODUCT_DESIGN.md`，然后按需更新 `docs/TECHNICAL_DESIGN.md`、`docs/DATABASE.md`、`docs/AI_RULES.md`、`docs/ARCHITECTURE.md`、`docs/PHASES.md` 并新建后续阶段留档；本设计稿不直接改写 V1.2 事实源。

主要触点：

- 数据库和共享 Schema：词条三态覆盖字段、导入预览确认契约、导出/备份版本兼容、一次性迁移版本标记。
- Review / Today：有效目标与 mastered、首次 P 激活、到期查询、懒绑定、过期 Session 写入保护、切换目标时取消 pending P。
- Questions / prefetch / Library practice：正式 U 仅 Recall、正式 P 仅 Production；停止新 cloze 的生成、分配和预取。
- Read / AI：停止新的检查题与 reinforcement；若 `generate_read` 的实际输出契约改变，先改 Schema 和 `AI_RULES.md`，Prompt 升版改名并跑固定 fixtures 的真实模型 Eval。旧评估器至少保留到最后一个 V1.2 Session 过期，不在切换前拆除。
- Web：Library 三态控制、导入差异确认、Today 待生成/失败重试、旧 Session 刷新提示、动态任务数。PC 和手机功能语义一致。

## 验收重点

- Word 默认只有 Recall；Chunk 默认 Recall + Production；两者的显式覆盖都即时反映在 mastered 与**下一次**正式排期中，关闭 P 时当前 pending P 立即取消。
- 新词条的 P 不早于 Learn 次日；切换日已学 chunk 的旧 P 全部从 L0 到期；U 进度和历史完整保留；未学 New Queue 不被提前造句。
- Today / Library / prefetch 不出现新填空；Recall 选择题只通过 Hint 进入；Read 不产生新检查题或 reinforcement。
- 大队列可快速进入 Today；AI 失败只留下可重试 pending 任务；跨日旧任务、已取消任务及双设备重复提交均不能结算。
- 导入缺省字段不改已有目标，显式冲突必须在预览确认；旧/新备份恢复行为可预测。
- 开发按 Red → Green → Refactor：状态机与迁移单测、API 集成测试（临时 SQLite + `fastify.inject`）、用户可见流程 Playwright E2E；Prompt 变化跑对应 Eval。交付门槛为 `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`，以及涉及 Prompt 的 `pnpm ai:eval`。

## 尚待审核的两个实现细节

这些是为了让已确认的产品行为可安全落地，不改变其方向；实施计划中需明确：

1. 切换日的本地时区与一次性开关由现有用户/应用时区配置确定，避免服务器 UTC 午夜误触发。
2. 旧版备份恢复进入 V2 时，恢复流程如何标记「旧 P 尚未迁移」并做一次性重置，不能让普通启动迁移标记掩盖单次恢复的数据版本。
