# 新词初见即回忆（Learn 改 Recall Card）— 设计

日期：2026-09-27 夜（用户洞察：导入词都在 ChatGPT 见过/理解过，不存在"全新"；首触即应检验回忆）

## 语义（方案 A，用户拍板）

新词第一次接触即 **Recall Card**（与复习同组件）：显示 target+IPA+🔊+source_example → 自己回忆 → 显示答案 → 想起来了 / 没想起来（Hint 可用）。

| 路径 | result | outcomeSource | 结算 |
| --- | --- | --- | --- |
| 想起来了（recall 直判） | pass | recalled | 初始化 U(L1)+P 激活（现 correct 路径不变） |
| Hint 后选对 | basic_pass | assisted | 同上初始化（弱证据，明日以 Recall 回来） |
| 没想起来 / Hint 选错 | fail | forgot | **同样初始化** U(L1)+P（揭示释义+原句即教学时刻），明日短间隔 Recall 回来 |

- 三路径都消耗当日额度并置 started（**现有行为已如此**，零改动）。
- **learn 任务不再插同会话补强**（reveal 即教学，明日复习回归；understanding/cloze 复习的补强不变）。
- 完成摘要：forgot 计入"未通过"→ 触发 Read 推荐，符合语义。

## 改动

### API（answerTodayTask learn 分支）

- 判定：learn 任务接受 `recall` 与 `{selectedOptionId, hintUsed}`（与 understanding 同契约；hint 对→basic_pass、错→fail、recall 直判）。
- 结算：learn 分支从 `if (correct) 初始化` 改为 **三路径都初始化**（correct 或 assisted/forgot 一律 writeDimState U+P）；result/outcomeSource 按上表映射；`viewedSource` 不适用。
- 补强预取/插入段：`task.taskType === 'learn'` 时跳过（注释说明 reveal 即教学）。

### Web

- `TaskCard` 分派：`taskType === 'learn'` 与 `'understanding'` 一样渲染 `RecallCard`（词行去重条件同步含 learn）。
- 删除 `LearnContent`（不再被引用）及其专属测试。
- Learn 原两阶段（释义模糊→展开）与补充/个人例句展示随组件移除——首触以 source_example 为上下文足够（PRODUCT §4.2 同步改写）。

### 不变

U/P 初始化函数、调度、补强（复习路径）、New Queue/额度、extend、统计计数、迁移（零 schema 变化）。

## 测试

- API：learn recall 三路径（初始化两维/额度/result/outcomeSource）、hint 对/错、learn fail 不插补强、幂等回放。
- Web：learn 渲染 RecallCard、冻结三态；删除 LearnContent 用例。
- e2e：主流程 gravity Learn 段改 recall；extend 用例新词卡改 recall；其余适配。

## 明确不做

- 不做"必须重试到想起来"（B 方案）。
- 不给 learn 增加补充例句展示。
- 不改 reinforcement 对复习任务的规则。
