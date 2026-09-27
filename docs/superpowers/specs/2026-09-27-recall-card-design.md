# Understanding 改造：Recall Card 主动回忆优先 — 设计

日期：2026-09-27 晚（用户提供完整需求文档，本规格为其与现有架构的最小改动映射，已确认）

## 核心映射

| 新概念 | 现有结构 | 调度语义 |
| --- | --- | --- |
| recalled（未用提示，自己想起） | `result='pass'` | 正常晋升 |
| assisted（Hint 选择题选对） | `result='basic_pass'` | 不升级、更短间隔再现（现有 basic_pass 语义） |
| forgot（没想起 / Hint 仍错） | `result='fail'` | 退 1 级 + 缩短间隔（现有 fail 路径，含补强） |

- 调度零新算法，完全复用 `advanceReviewState({kind: pass|basic_pass|fail})`。
- 统计层区分：`attempts` 新列 `outcome_source TEXT NULL`（'recalled'|'assisted'|'forgot'；仅 understanding 复习任务写入；历史行与 cloze/production/learn 为 NULL）。
- 完成摘要沿用 通过/基础通过/未通过 三档（recalled→通过、assisted→基础通过、forgot→未通过）。

## API / 数据

1. `AnswerRequest` 增 `recall: 'recalled'|'forgot'`（可选）与 `hintUsed: boolean`（可选）。
2. `answerTodayTask` understanding 分支（taskType==='understanding'）：
   - `body.recall` 存在：correct = recall==='recalled'；result = pass/fail；outcomeSource 对应。
   - 否则（hint 模式提交 selectedOptionId）：evaluateChoice；对 → **basic_pass**（不再受 viewedSource 影响），错 → fail。
   - `viewedSource` 对 understanding 不再降档（Recall 卡默认展示 source_example）；cloze 语义不变；learn 首题路径不变（仍 pass/fail）。
3. `AnswerResponse` 增 `outcomeSource`（可空）；幂等 `replayAnswer` 从 attempts.outcome_source 回填。
4. Migration：attempts 加 `outcome_source` 列（drizzle-kit 生成；向后兼容）。

## 前端（Today 会话）

- 新 `RecallCard`（understanding 复习任务专用）：
  - 提示态：target + IPA + 🔊（speak 复用 lib/tts）+ source_example（存在时）+ [给我提示] [显示答案]；不显示 meaning/选项。
  - 显示答案后：meaning + notes 折叠（<details>）+ [没想起来] [想起来了]。
  - Hint：渲染现有 `ChoiceQuestionCard`（仅答题形态，无反馈 chips），提交 `{selectedOptionId, hintUsed:true}`；提交后进入冻结反馈态。
  - 冻结反馈（TaskCard result 冻结机制不变）：recalled=想起来了 ✓；assisted=提示后想起（基础通过）；forgot=没想起来 ✗ + 正确 meaning + source_example 突出块。
- `TaskCard` 分派：taskType==='understanding' → RecallCard（hint 题目=任务绑定 question）；learn/cloze/production 不变。understanding 时 TaskCard 顶部词行跳过（RecallCard 自带词行）。
- 自动发音（切卡）对 Recall Card 自然生效。

## 不变

Learn 首题（选择题）、Fill、Production（GLM 批改/diff/betterVersion）、Read、Today 架构、补强机制、间隔表、题库缓存（understanding 库存题目即 Hint 题源）。

## 测试

- API：understanding 三路径结算/调度映射（advance kind 断言）、learn 不变、幂等回放带 outcomeSource、viewedSource 不再影响 understanding。
- Web：RecallCard 状态机（提示/揭示/hint/冻结三态文案）、TaskCard 分派、notes 折叠。
- e2e：主流程理解题作答改 recall/hint 路径；倒计时/导航用例适配。

## 文档

PRODUCT_DESIGN §6.3/§7.1：understanding 训练形式改 Recall Card（主动回忆优先，选择题为 Hint；三档证据映射）。

## 明确不做

- 不改统计页面（仅底层数据区分）。
- 不引入 Anki 四键。
- 不动 distractor 生成（现库选项已是中文释义）。
