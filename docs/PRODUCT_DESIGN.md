# English Learning Tool V1.2 — Product Design

> 产品行为、学习机制与交互基线

**Version 1.2 · 2026-09-24**

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
| mastered | Understanding 与 Production 均稳定；退出正式 Today，仅可在 Read 中自然复现。 |
| paused | 临时暂停；保留全部历史与进度。 |
| archived | 软删除；默认在 Library 隐藏，但可筛选并恢复。 |

V1.2 不提供 Learning Item 的物理删除入口。

## 3.4 New Queue

批量导入的学习项首先进入 New Queue，而不是当天全部开始学习。Today 每天按额度从 New Queue 引入新的 Learn，已到期旧复习不受新学习额度影响。

> 默认 max_new_items_per_day = 10。Settings 可调整为 5 / 10 / 15 / 20 / 不限制。

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
target + 中文释义 + source example + 最多 1 条补充/个人例句 + 发音
  ↓
首道 Understanding 题（优先使用 source example）
  ↓
首道题通过：建立 Understanding 状态，并激活 Production 初始状态
  ↓
Production 从下一次到期开始以填空为主
```

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

同一个 Learning Item 在单个 Session 内最多动态追加 2 道补强题。补强题不得立刻重复出现，应至少间隔若干题或进入队列后段，避免形成机械短时记忆与无限增长。

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
| 其实蒙的 | 按 fail 处理。 |
| 太简单 | 在正常晋升基础上最多额外跳 1 级，不允许一次跨越多个阶段。 |
| 两个维度均 stable | Learning Item 自动进入 mastered。 |

## 6.3 Production 启动与题型映射

新 Item 首道 Understanding 题通过后，激活 Production。Production 的第一次正式复习默认安排在下一天。

| Production 阶段 | 主要题型 |
| --- | --- |
| P-L1 ～ P-L2 | 填空为主。 |
| P-L3 | 填空 + 表达题混合。 |
| P-L4 ～ P-L7 | 表达题为主，必要时少量填空。 |

Understanding 到期时使用选择题或上下文理解题；Production 到期时按上表选题。Today 不要求每个 Learning Item 每次做完整套题，只处理真正到期的维度。

## 6.4 查看原句

理解题和填空题默认不显示 source example。用户可主动点“查看原句”；一旦查看，本题即使答对也最多记为 basic_pass，不升级。答错时自动展示 source example 作为纠正反馈。

## 6.5 坏题与作答撤销

用户可对 AI 题点击 👎。一旦标记为坏题，本次作答视为无效：不升级、不降级，并取消由该题产生的补强任务；题目进入 bad_question，不再进入练习池。

## 6.6 题目缓存失效

| 编辑内容 | 处理 |
| --- | --- |
| target / meaning | 立即将该 Item 的 fresh / active AI 生成题全部 retired；新题按新内容生成。 |
| source_example / extra_examples / notes / tags | 不清题、不重置学习进度。 |
| meaning 明显换成不同义项 | 除清题外，再询问是否重置 Understanding / Production 进度。 |

# 7. 题型与 AI 批改设计

## 7.1 理解题

两类混合：直接词义选择 + 新上下文中的词义选择。第一次 Learn 后的首题优先使用 source example；第二次复习开始逐渐增加 AI 生成的新上下文。

缓存选择题保存 option id 与 correct option id，不保存固定 A/B/C/D 顺序。每次展示时前端重新 shuffle 选项，避免记住选项位置。

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
| 选择题 | 约 2 秒后自动下一题；点击任意处可立即继续。 | 停留，显示正确答案 + 一句解释；当天后部插入新题，受补强上限约束。 |
| 填空题 | 显示完整句子，手动下一题。 | 显示正确答案、完整句子和简短解释；当天后部插入新题，受补强上限约束。 |
| 表达题 | 显示批改结果，手动下一题。 | 显示批改结果；不强制当天重做，只调整后续间隔。 |

# 8. AI Read 阅读复现

Read 的目的不是训练完整阅读理解，而是让已经学过的词在新的、自然的上下文里再次出现。它不属于 Today 的硬性任务；Today 完成后可以智能推荐，但不读也算今日完成。

## 8.1 内容生成规则

| 项目 | 规则 |
| --- | --- |
| 重点目标词 | 3～5 个。优先选择近期 fail / basic_pass 或 Production 较弱项；必须自然出现并轻微高亮。 |
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
| 少颜色 | 状态以文字、轻微色阶和细节体现，不使用五颜六色进度条。 |
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
