# English Learning Tool V2 — Product Design

> 产品行为、学习机制与交互基线

**Version 2 · 2026-09-30**

> V2 学习契约：Learn → Recall → 按词条目标选择性 Production → Read 自然复现。下文保留的 V1.2 填空题、Read 检查及相关补强描述仅解释切换前历史；V2 不再生成或安排这些任务。切换和保留历史的完整规则以本节及 §6–§9 为准。

## V2 生效规则（覆盖下文 V1.2 题型与排期描述）

- 每项长期保存三态 `production_enabled_override`：`null` 随类型默认，`true` 明确需要造句，`false` 明确不需要。有效值为 `override ?? (type === 'chunk')`；Word 默认关闭，Chunk 默认开启。无需 AI 分类，类型不因覆盖而变化。
- `mastered` 只按当前目标判定：Understanding 稳定且（不需 Production 或 Production 稳定）。目标变化时由服务端重算 active/mastered 与任务资格，保留两个维度的历史、Stage 和排期；paused/archived 不自动恢复。关闭 Production 立即取消当前 Session 未答 P 题；重新开启沿用 V2 中已有的 P 状态。新开启的 P 最早加入下一次 Today，不中途插题。
- Learn 建立 Understanding；需要 Production 的新词条，首道正式造句最早在 Learn 后下一本地日，不需等待 Understanding 升级。之后 U/P 独立按 1/3/7/14/30/60/120 天阶梯调度。U 正式任务只使用 Recall：看 target 与语境主动回忆，答案揭晓后自评（2026-10-03 起无「给我提示」入口）；历史四选一作答回放仍标出正确选项及理由。P 正式任务只要求在 target 可见时完成具体中文语义任务的完整英语句子，由 AI 判目标用法、语法、搭配及语境；失败不强制当天再次造句。
- 不再生成、预取、分配新的填空题。Library「练一下」不凑固定题量：不需 P 时一道 Recall，需 P 时一道 Recall 加一道完整造句；不改变正式 Stage、排期、Today 结算或 mastered，单题生成失败可重试，不用填空或选择题补位。
- Read 仅提供可选文章和已学表达自然复现，不生成新检查题，不改变 Stage、Today 排期或 reinforcement。旧文章与旧检查作答保留只读；V2 切换时清除旧 Read 检查遗留的 `needs_reinforcement`，不改正式 Stage。
- Today 显示全部到期任务，无每日旧复习上限或迁移限流；未完成不算失败，次日本地日新 Session 重新纳入。创建 Session 先快速返回任务和进度，仅当前题及少量前瞻题按需生成/绑定；生成失败留下可重试 pending 任务，不计作答或降级，也不从总数消失。题目生成不能在 SQLite 写事务内等待 AI，绑定需并发保护。
- 导入可选 `production_enabled_override`；缺省不等于 `false`，新项按 `null` 保存。重复导入缺字段时保留现值，显式三态冲突在预览中指出并经用户确认，即使其他字段完全重复也不得静默跳过。Library 修改、普通导出和完整备份保留显式值；旧备份缺字段按 `null` 导入。V2 备份保留 V2 Production 状态。
- V2 在用户配置的下一本地日边界生效。边界前旧 Session 可按旧题完成；跨界未答旧任务过期不算失败，旧标签页对过期 Session 的提交和撤销由服务端拒绝并提示刷新。一次性、事务化、可重试迁移保留 U 状态、历史尝试、个人例句和统计；所有旧词条 P 从 L0 重来。已 Learn 且需 P 的 active 项在切换日立即到期；未 Learn 的 New Queue 等 Learn 后至少下一本地日。重算 active/mastered，维持 paused/archived，清除旧 Read reinforcement。迁移须有版本标记；旧备份恢复也要应用同一旧 P 重置语义，不可被普通启动迁移标记掩盖。

# 1. 项目背景与问题定义

用户此前使用 Anki 记录和复习英语单词与词组，但传统卡片模型逐渐暴露出几个问题：复习形式固定、容易记住卡片而不是真正掌握表达、主动输出训练不足、同一个词在不同上下文中的迁移能力弱，同时卡片维护成本较高。

用户平时已经习惯通过 ChatGPT 等工具完成单词、词块和例句的解释、比较与筛选，因此本项目不重复建设“查询/对话式英语助手”，而是把已经确认值得学习的内容导入专门的学习系统，由系统负责后续复习、出题、造句批改和上下文复现。

> 核心定位：这不是查词软件，也不是大而全的语言学习平台，而是一套只服务个人长期使用的轻量复习系统。用户决定学什么，系统负责让这些内容逐步变成真正可理解、可回忆、可使用的英语。

## 1.1 现有痛点

- Anki 以卡片为中心，同一个学习项长期绑定固定提示和固定答案，容易形成“认卡不认词”。
- 纯翻卡对主动输出帮助有限，尤其难训练“我能不能自己把这个表达用出来”。
- 大量手动维护卡片、例句、标签和复习状态，长期使用成本高。
- 复习材料与真实上下文脱离，旧词在新语境中的迁移训练不足。
- 商业英语 App 功能过多，听力、社交、语音对话、游戏化、打卡、课程等并非当前核心需求。

## 1.2 解决思路

把“Learning Item（学习项）”而不是“卡片”设为系统核心。选择题、填空题、表达题和 Read 都只是同一学习项在不同阶段的训练形式。题目属于可再生缓存，真正长期保留的是学习内容、长期例句和掌握状态。

# 2. 产品目标、原则与 V1.2 边界

## 2.1 产品目标

| 目标 | 说明 |
| --- | --- |
| 低摩擦 | 打开 Today 就能学习，不要求用户先选择模式、配置计划或打卡。 |
| 从理解到输出 | Understanding 与 Production 独立维护，而不是一个模糊总熟练度。 |
| 避免背题 | 题目动态生成、缓存和退休；中后期逐步切换到新上下文。 |
| 个人化沉淀 | 优秀的个人造句可进入 Personal Example，参与后续复习。 |
| 可承接大批量旧卡 | 支持一次性导入较多 Anki 存量，但通过 New Queue 控制每天真正开始学习的新项数量。 |
| 跨设备同步 | PC 与手机 PWA 使用同一服务端数据，Today Session 可续接。 |
| 长期可维护 | 核心数据可导出、可备份；派生数据按生命周期清理。 |

## 2.2 产品原则

- Simple first：若一个功能不能明显提升日常学习体验，则不进入 V1.2。
- Single source of truth：服务器数据库是唯一正式数据源；前端不承担核心离线业务数据。
- AI is replaceable：模型只负责明确的文本生成或判断任务，不承担系统调度和状态管理。
- Core data vs. derived data：学习项、长期例句和复习状态是核心资产；题目、Read、临时例句和日志是可回收派生数据。
- Quiet UI：视觉克制；一页一个主动作；不做企业 Dashboard，不做强游戏化。
- Product behavior first：任何会改变学习行为的规则必须先在产品文档中定义，Agent 不得自行补齐。

## 2.3 V1.2 明确不做

| 不做 | 原因 |
| --- | --- |
| 英语查询 / 对话 | 继续使用 ChatGPT 等工具；本系统只接收已确认的学习内容。 |
| 手机端手工新增学习项 | 数据入口保持单一；新增内容通过 PC Import 进入。 |
| 独立 Practice 页面 | 正式训练只有 Today；Library 详情仅提供一个轻量“练一下”。 |
| AI 音频生成 | 发音使用浏览器 SpeechSynthesis。 |
| 语音对话 / STT / 发音评分 | 偏离当前复习闭环。 |
| 离线业务数据与离线同步 | 手机和 PC 都联网使用；不实现 Conflict Resolution。 |
| 复杂 Streak / 排行榜 / 成就 | 仅保留 GitHub 风格学习热力图。 |
| 复杂统计 Dashboard | Stats 只保留少量长期有意义的数据。 |
| 多账号、注册、OAuth | 系统只服务单用户。 |

# 3. 核心概念与信息架构

## 3.1 Learning Item

系统只存在两类学习项。

| 类型 | 定义 | 示例 |
| --- | --- | --- |
| word | 单个词。可显示 IPA。 | gravity / raw / stable |
| chunk | 可复用词块、固定搭配、句型骨架或短句。无需 IPA。 | wear down / be supposed to ... / That makes sense. |

长句不作为独立学习项，只作为 source example。短句如果本身具有独立、可复用价值，可以作为 chunk。

同一个 target 可以重复存在。系统只记录用户实际遇到并决定学习的义项；以后遇到另一个重要义项，再新增同名 Learning Item，而不是把系统做成完整词典。

## 3.2 例句分层

| 层级 | 生命周期 | 用途 |
| --- | --- | --- |
| source_example | 永久；每项 1 条 | 最初遇到学习项的原句；首次 Learn 的记忆锚点。 |
| extra_examples | 长期；建议最多 3 条 | 导入合并或手工编辑得到的补充参考例句，不参与自动淘汰。 |
| personal_examples | 长期；最多 3 条 | 来自用户表达题的优质句子；使用 corrected 版本。 |
| generated_examples | 短期；随题删除 | 模型为选择题、填空题等生成的新上下文，不污染长期例句库。 |

Personal Example 自动优先选择更具体、与用户自身工作/生活/兴趣相关、目标词用法典型的句子。满 3 条后，如果新句明显更优，只能淘汰未固定（unpinned）的低质量项。

> 用户手动收藏 Personal Example 即视为 pinned。Pinned Personal Example 永远不能被系统自动淘汰；只有用户主动取消收藏后，才重新进入自动替换候选。

## 3.3 Learning Item 状态

| 状态 | 含义 |
| --- | --- |
| active | 正常参与 Today 调度。 |
| mastered | Understanding 稳定，且当前目标要求 Production 时 Production 也稳定；退出正式 Today，仍可在 Read 中自然复现。 |
| paused | 临时暂停；保留全部历史与进度。 |
| archived | 软删除；默认在 Library 隐藏，但可筛选并恢复。 |

V1.2 不提供 Learning Item 的物理删除入口。

## 3.4 New Queue

批量导入的学习项首先进入 New Queue，而不是当天全部开始学习。Today 每天按额度从 New Queue 引入新的 Learn，已到期旧复习不受新学习额度影响。

> 默认 max_new_items_per_day = 10。Settings 可调整为 5 / 10 / 15 / 20 / 不限制。
>
> **同日追加（2026-09-27）**：额度在会话创建时消费，但当天提高额度后，完成页在剩余额度 > 0（或不限制）时提供"再学 N 个新词"——向当日会话追加一批 Learn 任务并重新激活（调度/统计与正常 Learn 同路径）。

```text
Imported ≠ Learned

PC Import → New Queue → 每日最多 N 个 → Learn → Active Review
```

## 3.5 主导航

| 入口 | 手机 PWA | PC | 职责 |
| --- | --- | --- | --- |
| Today | 底部导航 | 左侧导航 | 唯一正式复习入口。 |
| Library | 底部导航 | 左侧导航 | 搜索、查看、编辑、暂停/恢复、归档，以及单项“练一下”。 |
| Read | 底部导航 | 左侧导航 | 生成短文，在新上下文中复现旧词。 |
| Stats / Settings | 右上角菜单 | 侧栏底部或右上角 | 轻量统计、导入导出、恢复与设置。 |

# 4. 关键用户流程

## 4.1 内容进入系统

```text
ChatGPT / 其他工具整理学习内容
  ↓
生成标准 JSON
  ↓
PC Import
  ↓
格式校验 + 重复检测
  ↓
导入预览（合并 / 新增 / 跳过）
  ↓
确认导入
  ↓
进入 New Queue
  ↓
Today 按每日新学习额度逐步引入
```

导入导出只在 PC 提供。手机 PWA 专注学习，不承担数据管理入口。

## 4.2 新学习项第一次学习

```text
Today 从 New Queue 取出新项
  ↓
Learn 页面
  ↓
target + IPA + source example（回忆上下文，不展示释义）——初见即 Recall Card（2026-09-28 起用）
  ↓
自己回忆 → 显示答案 → 想起来了 / 想错了
  ↓
两路径都完成新学（消耗额度）：recalled=pass / forgot=fail，均建立 Understanding 初始状态并激活 Production（历史 assisted=basic_pass 数据保留兼容）
  ↓
Production 从下一次到期开始为整句表达（V2）；forgot 明日以 Recall 短间隔回归
```

Recall「显示答案」后自评「想起来了 / 想错了」，两键均评分即前进（答案已在屏，不冻结重放）；揭示前主动「没想起来」停留在当前卡，先看答案再继续。「想错了」与「没想起来」同权（均未通过）。误操作可用卡片右上角的撤销图标撤销最近一次作答；坏题另在「今日学习」的答题记录中标记。

## 4.3 日常复习

```text
打开 Today
  ↓
加载 / 恢复 Today Session
  ↓
理解题、填空、表达题按到期状态混排
  ↓
错误按规则插入少量补强任务
  ↓
清空基础任务与“稍后再做”任务
  ↓
今日完成摘要
  ↓
可选：推荐生成一篇 Read
 ↓
可选：同日追加"再学一批"（额度剩余时）
```

## 4.4 Library 单项“练一下”

Library 详情提供低调的“练一下”按钮，临时生成约 3 道与该 Item 当前阶段匹配的题。该入口不是正式复习，不改变 Stage 与 next_review_at，不制造补强任务，不计入 Today 进度，也不计入热力图正式复习任务。

如果“练一下”中完成表达题，优质 corrected 句子仍可进入 Personal Example，因为 Personal Example 属于长期语言资产，而不是复习调度数据。

## 4.5 跨设备

PC 和手机访问同一套 API 和数据库。Today Session、学习状态、题目作答和 Read 历史均存服务端，因此可以在 PC 做到一半后继续在手机上完成，反之亦然。多设备重复提交同一个任务不得造成重复结算。

# 5. 页面与交互设计

## 5.1 Today

Today 是产品核心页。首页只突出一个主要动作：开始或继续今日复习。不要堆叠大量统计卡片。

```text
Today

18 items due · 3 new today

[ Start today's review ]

Recently learned
wear down
raw
steady
```

若当天 Session 已开始，主按钮改为“继续今日复习 · 18 / 32”。补强题动态插入后，总任务数同步增加。

每道题允许“稍后再做”。该题移动到 Session 后部，不算对错、不影响学习状态。允许多次稍后，但 Today 完成前必须清空。

### 会话卡片、进度与今日学习（2026-09-28 迭代）

- 移动端一题一屏：题卡填满顶栏和底部导航之间的空间；题干、反馈可滚动，操作区固定在题卡底部。填空与表达输入框也在底部操作区，填空题切入时不自动弹出键盘。用户点输入框后，键盘出现时顶栏、进度和题干的屏幕位置不变，底部导航由键盘覆盖/隐藏，只有卡片底部操作区随可视高度上移；输入框和提交按钮贴键盘上沿且仍可见。键盘收起后恢复原布局，不让整页因聚焦输入框而跳动。
- 顶部显示已完成题数 / 当前总题数，并以绿色 `pass`、黄色 `basic_pass`、红色 `fail`、灰色未完成表示结果分布；同时显示文字或数字，不只靠颜色。补强动态增加时总题数同步更新。
- 点击进度打开「今日学习」：按 Learning Item 去重，展示词/词块、IPA（仅 Word）、释义及今天各题结果轨迹；展开后可只读查看具体题目、作答、正确答案与解释，支持从具体记录标记坏题。关闭后回到原当前题。进度区和列表均不用于跳题、回看导航或重答。
- 答题中卡片右上角为单个撤销图标，触发后确认层写明将撤销的词、题型和结果。反馈态指向本题；自动进入下一题后指向最近一次正式作答。完成页也保留最近一次作答的撤销入口。图标提供无障碍名称。
- 普通撤销只适用于当天 Session 最近一次未撤销的正式作答，且在下一次作答前。服务端按 task/attempt 精确定位并在同一事务恢复前态、取消该次产生的补强、回减统计与新学额度、恢复本次替换/裁剪的个人例句与表达历史、作废该次 attempt，并重新激活已完成的 Session。若本次新增的例句已被用户固定或编辑，则拒绝撤销以保护用户修改。被撤销题目仍可留在题库，不标坏题；原题不再直接重答，系统取不同的新题安排在本 Session 后部。没有可用新题时保持原作答不变并提示重试。补强题替代只占用原配额槽位，不额外消耗上限。其他设备已提交更新时服务端拒绝过期撤销。

同一个 Learning Item 在单个 Session 内最多动态追加 2 道补强题。补强题不得立刻重复出现，应至少间隔若干题或进入队列后段，避免形成机械短时记忆与无限增长。

按钮颜色全局唯一出处是 Button 组件语义变体（primary/neutral/negative/destructive/ghost）；应用内 `/tokens` 页真渲染色板与按钮矩阵，为权威色卡（2026-10-02 起）。

## 5.2 Library

Library 使用简洁列表，展示 target、中文释义、理解/输出自然语言状态和来源。详情页展开具体阶段、下次复习时间和长期例句。

| 搜索 | 固定筛选 |
| --- | --- |
| target、meaning、source example、extra/personal examples、tags、source 全字段模糊搜索 | 全部 / Word / Chunk / 学习中 / 已掌握 / 已暂停 / 已归档 |

允许编辑 target、meaning、ipa（仅 word）、source example、extra examples、personal examples、source、source_url、tags、notes。`ipa` 可选：导入 JSON 中为可空字段，Library 详情可随时补充编辑。内部 Stage 和 next_review_at 不允许直接编辑，但提供“重置进度 / 标记已掌握 / 暂停 / 恢复 / 归档”等显式操作。

详情页提供“练一下”，不新增独立 Practice 导航。

## 5.3 Read

Read 首页主要动作是生成阅读；下面仅显示最近 3 篇，更多历史进入 History。普通文章保留 30 天，收藏文章长期保留。

## 5.4 Stats

Stats 不放主导航，只提供少量有长期意义的数据：总学习项、Word/Chunk 数量、学习中/已掌握/已暂停、New Queue 数量、最近 7 天正式复习任务数、表达题通过率、最近 30 天新增学习项。

提供 GitHub 风格 12 个月热力图。每格按当天完成的正式 Today 任务数着色，不显示连续学习天数，也不把断档设计成惩罚。Library 的“练一下”不计入热力图。

## 5.5 Settings

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 每日新学习项上限 | 10 | 5 / 10 / 15 / 20 / 不限制。 |
| 内容难度 content_level | B1 | 用于约束 AI 生成的新上下文和 Read，避免大量无关生词。 |
| TTS voice | 优先 en-US | 从浏览器可用 voice 中选择；不保存音频。 |
| AI 模型（只读） | 自动 | 展示当前题目生成/判定批改各自使用的模型名、来源（自动选择最新 / 配置指定）与思考强度档位（关/低/高/最大），只读不可在界面修改。 |

# 6. 学习与复习机制

## 6.1 两维能力状态

| 维度 | 含义 | 主要训练 |
| --- | --- | --- |
| Understanding | 看到词/词块和上下文时能否理解。 | 词义选择、上下文理解。 |
| Production | 能否主动回忆并正确使用。 | 填空、表达题。 |

两个维度各自维护独立 Level、next_review_at、last_review_at 等必要状态。列表默认只显示“初学 / 练习中 / 稳定”等自然语言状态，详情页才显示内部细节。

## 6.2 阶梯间隔

V1.2 使用透明的阶梯式间隔，不引入 FSRS。默认间隔：1 → 3 → 7 → 14 → 30 → 60 → 120 天。每个维度从 L1 到 L7；首次成功后进入 L1。L7 到期再次成功后，该维度标记 stable。

| 事件 | 处理 |
| --- | --- |
| 正常答对 / pass | 当前维度晋升 1 级；按新级别安排 next_review_at。L7 到期再次成功后标记 stable。 |
| basic_pass | 不升级；按更短间隔再次出现。用于表达题存在轻微错误或用户查看原句后完成。 |
| 答错 / fail | 当前维度退 1 级（最低不低于 L1）并缩短间隔；理解/填空题可追加补强。 |
| 主动不会 | 对本题按 fail 处理；理解题为 forgot，填空和表达题分别影响 Production。 |
| 太简单 | 在正常晋升基础上最多额外跳 1 级，不允许一次跨越多个阶段。 |
| 两个维度均 stable | Learning Item 自动进入 mastered。 |

## 6.3 Production 启动与题型映射

新 Item 首道 Understanding 题通过后，激活 Production。Production 的第一次正式复习默认安排在下一天。

| Production 阶段 | 主要题型 |
| --- | --- |
| P-L1 ～ P-L2 | 填空为主。 |
| P-L3 | 填空 + 表达题混合。 |
| P-L4 ～ P-L7 | 表达题为主，必要时少量填空。 |

Understanding 到期时使用 Recall Card（主动回忆优先，见 §7.1）；Production 到期时按上表选题。Today 不要求每个 Learning Item 每次做完整套题，只处理真正到期的维度。

## 6.4 查看原句

填空题默认不显示 source example。用户可主动点“查看原句”；一旦查看，本题即使答对也最多记为 basic_pass，不升级。答错时自动展示 source example 作为纠正反馈。（2026-09-27 起：理解题 Recall Card 默认展示 source_example 作为回忆上下文，不再有查看降档，见 §7.1。）

## 6.5 坏题与作答撤销

用户可在「今日学习」的具体题目记录中标记坏题。标记后本次作答视为无效：不升级、不降级，并取消由该题产生的补强任务；题目进入 bad_question，不再进入练习池。普通撤销与坏题是不同操作，普通撤销保留题目资格并补另一道新题。

## 6.6 题目缓存失效

| 编辑内容 | 处理 |
| --- | --- |
| target / meaning | 立即将该 Item 的 fresh / active AI 生成题全部 retired；新题按新内容生成。 |
| source_example / extra_examples / notes / tags | 不清题、不重置学习进度。 |
| meaning 明显换成不同义项 | 除清题外，再询问是否重置 Understanding / Production 进度。 |

# 7. 题型与 AI 批改设计

## 7.1 理解题（2026-09-27 改版：Recall Card 主动回忆优先）

Understanding 复习任务的默认形式是 **Recall Card**：展示 target（+IPA+发音）与 source_example，不展示释义与选项；用户可直接点「没想起来」，或先点「显示答案」再自评 **想起来了 / 想错了**。答案含 meaning 与默认展开的 notes。

**选择题不再出现在正式 Recall 流**（2026-10-03 起无「给我提示」入口——再认弱于回忆、显示答案自评已覆盖中间档）；选择题组件与 hintUsed/基础通过判定仅用于历史作答回放与旧数据兼容。

### 三档学习证据（复用现有调度，零新算法；assisted 档仅历史数据）

| 证据 | 触发路径 | result | 调度 |
| --- | --- | --- | --- |
| recalled | 未用提示，自己想起 | pass | 正常晋升 |
| assisted | 历史数据：提示后选对（入口已移除） | basic_pass | 不升级，更短间隔再现 |
| forgot | 没想起 | fail | 退 1 级 + 缩短间隔 + 补强 |

- attempts.outcome_source 记录三档来源（历史行为 NULL，回看展示按 result 回退），供未来统计区分"看选项会、主动想不起来"。
- Recall 卡默认展示 source_example（回忆上下文，不是答案），understanding 不再有"查看原句降档"；forgot 时反馈区突出展示 source_example。
- 新词首触同 为 Recall Card（2026-09-28"初见即回忆"：导入词已在 ChatGPT 理解过，首触检验回忆；两路径都完成新学，forgot 揭示即教学、明日短间隔回归，learn 不再插同会话补强）。选择题缓存与前端 shuffle 机制保留（供历史作答回放与旧数据兼容）。

## 7.2 填空题

填空题作为 Understanding 与完整 Production 之间的过渡。允许符合语法的词形变化，不要求字符串完全一致。出题时 AI 同时返回标准答案、可接受变形或判定规则；只有本地/后端无法确定时才考虑 AI 兜底。

## 7.3 表达题

V1.2 不单独区分“中译英”和“自由造句”。统一为受控表达：给出明确中文句子，并要求必须使用目标 word/chunk 来表达。题目可预生成和缓存，用户提交后实时调用模型批改。

```text
目标：wear down
题目：请使用 wear down 表达：“长期的压力让我越来越疲惫。”
用户答案：The constant stress wear me down every day.
```

## 7.4 表达题批改 UI

批改分两步：先纠正用户原句，再提供可选的更自然表达。必须遵守“最小修改原则”，不要把纠错和润色混在一起。

| 层级 | 规则 |
| --- | --- |
| 判定 | pass / basic_pass / fail。 |
| Correction | 默认展开；删除内容红色删除线，新增内容绿色显示；只做必要修改。 |
| Explanation | 1～2 句简短说明关键错误。 |
| Better version | 只有明显改善自然度时才出现；默认折叠。原句已经自然时不强行改写。 |

```text
{
  "result": "basic_pass",
  "segments": [
    {"text":"The constant stress ","type":"same"},
    {"text":"wear","type":"delete"},
    {"text":"wears","type":"insert"},
    {"text":" me down every day.","type":"same"}
  ],
  "explanation": "stress 是单数主语，动词需使用第三人称单数。",
  "better_version": "The constant stress is wearing me down."
}
```

## 7.5 Personal Example

系统可保留 original、corrected、better 三个版本，但只有 corrected 版本有资格进入 Personal Example。近期原始造句历史每个学习项最多保留 10 次；超出的未收藏记录自动清理。

Personal Example 最多 3 条。系统可自动替换 unpinned 低质量项，但不得自动删除 pinned 项。

## 7.6 答题反馈

| 题型 | 正确 | 错误 |
| --- | --- | --- |
| Recall | 「想起来了」自动下一题。 | 显示答案后「想错了」评分即前进；揭示前「没想起来」留卡揭示释义与原句，手动下一题；复习题按上限插补强。 |
| 填空题 | 显示完整句子，手动下一题。 | 主动「不会填」或填错都展示正确填空、完整句子、可接受变形和简短解释；手动下一题，按上限插补强。 |
| 表达题 | 显示批改结果，手动下一题。 | 主动「不会表达」展示参考句、目标用法和简短说明；写过答案后答错则展示最小纠错 diff 与解释。两者都手动下一题；不强制当天补强。 |

主动不会是独立的作答动作，后端直接按 fail 结算；不伪造选项或空答案。错误反馈与主动不会共享题型级版式，但主动不会不显示虚构的错误答案。普通撤销在该题结果揭示后需使用另一道题重练，避免看过正确答案后凭短时记忆获得晋级。

# 8. AI Read 阅读复现

Read 的目的不是训练完整阅读理解，而是让已经学过的词在新的、自然的上下文里再次出现。它不属于 Today 的硬性任务；Today 完成后可以智能推荐，但不读也算今日完成。

## 8.1 内容生成规则

| 项目 | 规则 |
| --- | --- |
| 重点目标词 | 3～5 个（2026-09-27 提示词按实测重写：契约前置+逐行词条，5 词稳定）。优先选择近期 fail / basic_pass 或 Production 较弱项；必须自然出现并轻微高亮。 |
| 已学旧词 | 额外 3～5 个；优先从稳定或 mastered 项中选择，能自然融入就融入，不强制、不高亮。 |
| 篇幅 | 动态 180～400 词，根据目标词数量和难度调整。 |
| 语言难度 | 受 content_level 约束，默认 B1；正文整体难度不应因目标词而明显失控。 |
| 类型 | 由模型自动选择故事、日常场景、小知识短文或简短观点文。 |
| 检查 | 读完后 1～2 道轻量目标词检查题，不考大量文章细节。 |

## 8.2 对复习状态的影响

Read 不直接推进或回退 Understanding / Production Stage。答对只作为阅读体验中的正反馈；答错则给对应 Learning Item 标记 needs_reinforcement，在下一次 Today 中安排一题额外正式复习。

## 8.3 Read 历史

Read 首页显示最近 3 篇，更多进入 History。普通文章保留 30 天；收藏文章永久保留。Read 不参加每日预生成任务，用户触发时实时生成。

# 9. JSON 导入、重复处理与恢复

## 9.1 学习库 JSON 格式

```text
{
  "version": "1.2",
  "items": [
    {
      "type": "chunk",
      "target": "wear down",
      "meaning": "逐渐使……疲惫；消耗",
      "ipa": null,
      "source_example": "It wears you down.",
      "extra_examples": [],
      "source": "Avatar S01E12",
      "source_url": null,
      "tags": ["Avatar"],
      "notes": "常用于长期压力、疲劳等逐渐累积的影响。"
    }
  ]
}
```

## 9.2 导入重复处理

| 情况 | 默认建议 |
| --- | --- |
| target 相同且 meaning 高度相近 | 合并；保留已有 source example，新例句作为 extra example 候选，不重置学习进度。 |
| target 相同但 meaning 明显不同 | 新增独立 Learning Item。 |
| 内容明显完全重复 | 跳过。 |

导入预览支持“全部采用系统建议”，但允许逐条修改。确认后新项进入 New Queue。

## 9.3 导出与恢复

| 类型 | 内容 | 用途 |
| --- | --- | --- |
| 学习库 JSON | 学习内容、长期例句、来源、标签、notes；不含复习进度。 | 迁移、查看、与 ChatGPT/其他工具交换。 |
| 完整备份 JSON | 学习库 + 理解/输出阶段 + next_review_at + 状态 + 必要统计；不含可再生 AI 缓存。 | 系统恢复。 |

PC 提供“恢复备份”。上传完整备份后先校验并显示备份时间、学习项数量和当前数据量，再二次确认覆盖恢复。恢复前必须自动创建一次当前数据快照。

# 10. 题库生命周期与清理机制

> 核心原则：Learning Item、长期例句与学习状态是主数据；题目、Read、临时生成例句和明细日志都是可回收派生数据。

## 10.1 题目生成策略

采用“定时预生成 + 懒生成兜底”。后端每天巡检未来 24～48 小时将到期的学习项，检查新鲜题库存并批量补题；用户临时需要而库存不足时，再即时懒生成。

| 题型 | 建议目标库存 | 最大库存 | 生成方式 |
| --- | --- | --- | --- |
| 理解选择题 | 3 | 8 | 每日预生成 + 懒生成 |
| 填空题 | 3 | 8 | 每日预生成 + 懒生成 |
| 表达题 | 2 | 6 | 每日预生成 + 懒生成；答案实时批改 |

## 10.2 题目状态

```text
fresh → active → retired → deleted
   ↘ bad_question → deleted
```

题目连续稳定答对后 retired；retired 超过 45 天且库存充足时物理删除。bad_question 保留 30 天用于短期去重参考，之后删除。

## 10.3 其他清理

| 数据 | 默认保留 |
| --- | --- |
| 普通 Read | 30 天；收藏永久。 |
| 近期造句与批改历史 | 每个学习项最近 10 次；收藏/进入 Personal Example 的长期保留。 |
| 生成题目例句 | 跟随题目生命周期。 |
| bad_question | 30 天。 |
| 明细学习日志 | 60 天；长期只保留聚合统计。 |
| mastered Learning Item | 长期保留；退出 Today，不自动删除。 |

# 11. AI 能力边界

AI 只承担确定性较强的文本生成或判断任务，不承担系统调度和状态管理。所有模型输出必须通过结构化 Schema 校验；失败时允许有限重试。具体 Schema、Prompt 契约、版本管理与 Eval 流程见 `AI_RULES.md`。

Prompt 本身属于工程配置，而不是用户侧产品数据：**Prompt Markdown 文件以 Git 仓库为唯一事实源，不保存到数据库，也不建设 Prompt 管理后台。** 数据库仅记录某次生成或批改实际使用的 `prompt_key / prompt_version / prompt_hash / model`，用于追溯质量与回滚。后续允许 Coding Agent 直接修改 Prompt 文件并运行固定 Eval Case 比较效果。

| AI 能力 | 是否实时 | 关键约束 |
| --- | --- | --- |
| generateUnderstandingQuestions | 否，预生成/缓存 | 锁定当前 meaning，不能生成 target 的其他义项。 |
| generateClozeQuestions | 否，预生成/缓存 | 返回标准答案、可接受变形或规则。 |
| checkCloze | 仅歧义时实时兜底 | 本地规则无法判断时，只判断用户答案是否属于 target 的可接受形式；不接受同义词替代。 |
| generateProductionPrompt | 否，预生成/缓存 | 中文提示明确，并要求使用 target。 |
| checkProduction | 是 | 先最小纠错 diff，再可选 Better version；三档判定。 |
| generateRead | 是 | 重点词 + 旧词；180～400 词；受 content_level 约束。 |
| judgeDuplicateMeaning | 导入时按需 | 仅辅助判断 meaning 相似度，最终由用户确认。 |

# 12. UI 视觉规范

视觉参考“安静、克制、内容优先”的体验，但不复制任何具体产品界面。核心特征是暖白背景、深灰文字、低饱和暖色强调、大量留白、细边框和极少阴影。

| 原则 | 要求 |
| --- | --- |
| 一页一个主动作 | Today 只突出开始/继续；Read 只突出生成阅读。 |
| 少 Card | 不要把每个数字和区块都放进独立卡片。 |
| 少颜色 | 页面总体克制；Today 进度条仅使用通过/基础通过/未通过三种语义色与未完成中性色。 |
| 少图标 | 图标只用于明确操作：发音、收藏、更多、返回等。 |
| 适合阅读 | PC 主内容 max-width 约 900px；手机保持舒适左右边距。 |
| 响应式 | 手机单栏 + 底部导航；PC 左侧导航 + 宽内容区。 |

## 12.1 发音

Word 显示 IPA + 发音按钮；Chunk 不显示 IPA，只提供发音按钮。词/词块和例句朗读均使用浏览器 SpeechSynthesis，优先选择 en-US voice。

## 12.2 Correction Diff

删除片段使用红色删除线；新增片段使用绿色文字或浅绿色背景。未修改片段保持普通正文色。Better version 放在折叠区，不与 Correction 混在同一视觉层级。

# 13. V1.2 Definition of Done

- PC 可以导入标准 JSON，并在预览页逐条处理疑似重复；大批量新项进入 New Queue。
- Today 支持每日新学习额度，旧复习不受该额度限制。
- 新学习项有 Learn 页面；Understanding / Production 独立调度。
- 选择题、填空题、表达题可完成；选择题展示时随机化选项顺序。
- 表达题能够实时 AI 批改，正确渲染 diff，并维护 pinned / unpinned Personal Example。
- 👎 坏题会撤销本次学习影响，并进入 bad_question。
- 单个 Item 在一个 Session 内最多追加 2 道补强题。
- Library 提供不改变正式进度的“练一下”，不建立独立 Practice 页面。
- Read 能按规则生成 180～400 词内容；答错只标记下次 Today 补强，不直接改变 Stage。
- PC / 手机 PWA 使用同一服务端数据，可续接 Today Session，重复提交不会重复结算。
- Library 可全文搜索、固定筛选、编辑/暂停/恢复/归档。
- Stats 有核心数字和 12 个月学习热力图。
- 浏览器 TTS 能朗读 word/chunk 与例句。
- 学习库 JSON、完整备份 JSON、覆盖式恢复可用。
- 题目、Read、历史日志按生命周期自动清理。
- Prompt 由仓库中的 Markdown 文件统一管理，AI 生成/批改结果可追溯到具体 Prompt 版本。

## 13.1 后续功能进入标准

V1.2 上线后，只有当某个真实使用痛点反复出现时才新增功能。不要因为“其他 App 有”“技术上能做”或“未来可能需要”提前加入模块。任何新增功能都应回答：它是否直接改善导入、复习、输出或上下文复现中的一个步骤？如果不能，默认不做。

> V1.2 最终闭环：ChatGPT 筛选学习内容 → PC JSON 导入 → New Queue → Today 自动复习 → 理解 / 填空 / 表达 → AI 精简批改 → Personal Example 沉淀 → Read 新上下文复现 → 自动清理与长期备份。

# 附录 A：核心默认参数

| 参数 | V1.2 默认值 | 说明 |
| --- | --- | --- |
| 每日新学习项上限 | 10 | Settings 可调整。 |
| 复习阶梯 | 1 / 3 / 7 / 14 / 30 / 60 / 120 天 | Understanding 与 Production 独立使用。 |
| 理解题目标库存 | 3 | 最多 8。 |
| 填空题目标库存 | 3 | 最多 8。 |
| 表达题目标库存 | 2 | 最多 6。 |
| 单 Item 单 Session 补强上限 | 2 | 避免 Today 无限增长。 |
| retired 删除 | 45 天 | 库存充足时执行。 |
| bad_question 保留 | 30 天 | 用于短期去重参考。 |
| 普通 Read 保留 | 30 天 | 收藏永久。 |
| 造句历史 | 每项最近 10 次 | 收藏 / Personal Example 例外。 |
| Personal Example | 最多 3 条 | Pinned 项不得自动淘汰。 |
| content_level | B1 | AI 生成内容整体难度约束。 |
