# FSRS 记忆调度算法替换固定阶梯 — 设计 Spec

日期：2026-10-03。状态：设计已获用户确认（对话内分节过审）。

## 背景与决策

现行排期为固定阶梯 `1/3/7/14/30/60/120` 天（pass 升一级、tooEasy 跳两级、fail 短间隔回归、L7 稳定吸收）。问题：不分难易、封顶 120 天、跳级是 hack。用户决策改用开源 **FSRS**（open-spaced-repetition，Anki 内置推荐算法），四个关键参数已定：

| 设计点 | 决策 |
| --- | --- |
| 目标记忆率 | 0.90 |
| mastered 判定 | 所需维度 stability ≥ 120 天 |
| 切换初始化 | attempts 全量回放重建 D/S |
| 参数 | FSRS 官方默认参数先行；个人拟合攒 ≈1000 条作答后另立项 |

方案选择：**ts-fsrs（官方 TypeScript 实现，MIT）全量替换 `advanceReviewState` 的阶梯核心**；混合方案与自写模型已否决。产品层（当日补强、稍后、撤销、坏题、New Queue、Read 复现）全部不动。

## 1. 算法接入

- 依赖 `ts-fsrs`（实施时锁定当前稳定版）；`generatorParameters({ request_retention: 0.90, maximum_interval: 365 })`，默认权重。
- 每个 `(learning_item, dimension)` 一套独立 FSRS 状态（difficulty / stability / last_review）。
- 评分映射（FSRS Rating）：
  - Understanding（今日正式作答）：重来→`Again`、良好→`Good`、简单→`Easy`（练一下 / read_check 不进状态）
  - Production：未通过→`Again`、基本通过→`Hard`、通过→`Good`
- 下次间隔 = FSRS 计算，**下限 1 天、上限 365 天**；`next_review_at = 结算时刻 + 间隔`，`last_review_at = 结算时刻`。
- 当日补强产生的同日重复作答照常进 FSRS（真实证据，elapsed 0 由算法处理）。
- **删除** `TOO_EASY_EXTRA_LEVELS` 跳级机制与 `INTERVALS_DAYS` 阶梯（简单键直接映射 `Easy`，跳步语义由算法自然给出）。

## 2. 数据模型（migration 0007）

`review_states`：
- 列变更：删 `level`、`stable`；加 `difficulty REAL NULL`、`stability REAL NULL`（NULL = 未激活，承接原 level=0 语义）。
- 保留：`next_review_at`、`last_review_at`、`correct_streak`、`wrong_streak`（streaks 继续按对错更新，仅作展示）。

attempt 状态快照（today/service.ts 的 pre/post JSON）：
- 增加 `difficulty`/`stability` 可空字段；恢复快照缺省时保持现值（沿用既有"旧快照无此字段"兼容模式）。

备份（v2.0 格式）：
- 导出：review 状态行增加 `difficulty`/`stability` 可空字段。
- 恢复：含 FSRS 字段的行直接还原；仅含旧 `level/stable` 的旧备份——恢复事务落库后用恢复进来的 attempts 跑同一回放函数重建 D/S（无 attempts 可回放的行保持未激活）。

## 3. 调度与产品层

- `advanceReviewState` 核心换为：读行 → FSRS `repeat(card, now, rating)` → 写回 D/S/next/last/streaks；原阶梯纯函数与测试同步重写。
- `mastered` 判定换谓词：所需维度（U 恒需；P 仅有效造句目标时）全部 `stability ≥ 120` → item.status=mastered；目标开关变化时 reconcile 沿用新谓词；paused/archived 不变。
- 阶段标签（`reviewStageLabel`）改为按 stability 分档：null=未开始、<7 新、<30 巩固、<120 熟练、≥120 掌握（消费方签名随迁移调整）。
- 到期查询（`next_review_at <= now`）、prefetch 过滤、补强插队、稍后、撤销、坏题、New Queue、跨日 409：全部不变。
- 统计口径（通过/基础通过/未通过）不变。

## 4. 切换迁移（一次性、幂等）

- `app_metadata` 标记 `fsrs`（仿 `foxi_v2` cutover 模式），boot 顺序：迁移 → Prompt Registry 校验 → v2 cutover → **fsrs 回放** → listen。
- 回放规则：对每个词条每维度，取 `mode='today'` 且题目 kind 为 `understanding`（→U）/`production`（→P）的 attempts，按 `created_at` 升序逐条映射 Rating 喂 ts-fsrs，终态写 D/S/next/last。**跳过**：cloze 题 attempts（V2 已作废其 P 证据）、`read_check` 与 `library_practice` 模式（从未进正式状态）。
- 无可回放 attempts 的行：U/P 保持 NULL（未激活）；已 mastered 的 item 由回放终态 + reconcile 重算（预期 S≥120 项保持 mastered）。
- 二次运行字节级 no-op；无本地日边界要求，任意时刻可部署。

## 5. 测试

- 单测（review-state-machine 重写）：Good 间隔单调增长且首次 ≥1 天；Easy 间隔 > Good；Again 间隔 < 前值且下限 1 天；stability≥120 触发 mastered（含双维度/单维度目标）；streaks 照常；删除 tooEasy 用例。
- 迁移单测：混合历史（含 cloze/read_check/practice 应跳过、乱序时间戳、已 mastered、未激活词）回放终态正确；幂等；旧备份恢复后重建。
- 集成：today/practice/library 现有套件回归（作答→next_review_at 落在合理窗）；备份 2.0 导出/恢复含 FSRS 字段 round-trip。
- E2E：现有 today/production 全量回归，无新增旅程。

## 6. 范围外

- 个人参数离线拟合管线（py-fsrs，攒数据后另立项）。
- 前端交互/文案改动（零）；Read 与统计改动。
- P 维度新增 Easy 档（AI 判分无此档）。
