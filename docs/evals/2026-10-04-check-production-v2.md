# check_production v2 发布评测 — 2026-10-04

## 结论与范围

2026-10-05 已部署到 Foxi。API 重启后健康检查通过；HTTPS 返回的页面、JS/CSS、Service Worker 与本次构建逐字节一致，生产 API/shared/Prompt/前端源码与工作树一致，运行目录仅保留 `check_production.v2.md`。上线 Prompt 内容 hash 与最后 14/14 评测版本一致。

建议发布 `check_production` v1 → v2。相同的 14 个固定输入在真实 `glm-5.3` 上对比：旧版评分符合预期 13/14，新版评分、Schema、segments 原文/纠正后重建及固定字段断言 14/14；逐句人工审阅通过。模型与生产调用策略保持一致，未用 mock 替代语言评测。

最终 v2 `prompt_hash`：`4c160fde5894e85db045e8888fb6a2e81aaf84fdd7fd9064a110c20d9a0a9a30`。由 Prompt Registry 自动生成，未手填到业务数据。完整评测报告保存于本机 `/tmp/production-polish-v1-final-results.json` 与 `/tmp/production-polish-v2-release-results.json`。

v2 区分最小纠错、沿用户原意的 polish、必要时的 rewrite 参考表达；评分只依据原答案。合格 polish 优先成为个人例句正文，否则评估并选择 corrected；rewrite 不自动沉淀。质量分评价实际选择的文本，插入与替换使用同一选择规则。现有三条上限、pinned 保护和替换差值门槛保持原规则。

## 相同输入的旧版／新版对比

| Case | 场景 | v1 → v2 评分 | 内容与候选选择核对 |
| --- | --- | --- | --- |
| cp01 | 自然的 wear down 答案 | pass → pass | 无额外润色；保存 corrected。 |
| cp02 | 第三人称单数错误 | basic_pass → basic_pass | 只纠正 wear → wears；保存 corrected。 |
| cp03 | raw 义项错误 | fail → fail | 旧版直接替换原因；新版纠错保留原意，另给 rewrite，不保存。 |
| cp04 | 不同但自然的 stable 答案 | pass → pass | 不向参考答案靠拢，无额外润色。 |
| cp05 | 未使用指定表达 | fail → fail | 旧版在纠错中补 target；新版原句不变，指定表达另放 rewrite，不保存。 |
| cp06 | 仅大小写、标点 | pass → pass | 最小修改，无额外润色。 |
| cp07 | welcom 拼写错误 | basic_pass → basic_pass | 只改 welcome；纠正后自然，不强行润色。 |
| cp08 | 完整自然答案 | pass → pass | better_version 与 kind 均为 null。 |
| cp09 | 两句自然表达共同期待 | pass → pass | 保留原两句及人物、时间，不为合并句子生成润色。 |
| cp10 | 缺少题目要求的原因 | basic_pass → fail | 旧版补原因并给通过；新版按原文判未完成题意，原因放 rewrite，不保存。 |
| cp11 | 主宾角色和意思错误 | fail → fail | 旧版纠错改成参考答案；新版不替用户改意思，另给 rewrite，不保存。 |
| cp12 | 主格与动名词错误 | basic_pass → basic_pass | 必要纠错后已自然，保存 corrected，无强制 rewrite。 |
| cp13 | 用户欢迎贵宾原句 | basic_pass → basic_pass | 纠错保持句架；polish 使用自然的集体称呼；候选明确选 better 并评价其文本。 |
| cp14 | 项目启动会议表达冗长 | pass → pass | 纠错不改，polish 简化搭配且保留人物、时间、事实；保存 better。 |

cp03、cp05、cp11 的旧版 AI 虽给出 eligible=true，既有业务层已阻止 fail 入库；新版也在 AI 契约中明确拒绝，不能把该差异描述为修复了旧版实际 fail 入库。

cp14 的旧版质量理由评价冗长的 corrected，但保存路径可能选择 better；新版明确选择 better，质量理由也评价同一润色文本。历史记录不重新批改、不回填分类。

## 代表结果

cp13 原句：`wlecome to every honored guests in our wedding.`

- 纠正后：`Welcome to every honored guest at our wedding.`
- 更自然的说法：`Welcome to all our honored guests at our wedding.`
- 判定：basic_pass；候选 source=better，quality_score=0.9。

cp14 原句：`My colleagues and I are looking forward to next week's meeting for the start of our project.`

- 纠正后保持原句。
- 更自然的说法：`My colleagues and I are looking forward to next week's project kickoff meeting.`
- 判定：pass；候选 source=better，quality_score=0.95。

cp10 原句：`The plan makes sense.`，题目要求说明同时节省时间和成本的原因。

- 纠正后保持原句，判 fail。
- 参考表达：`The plan makes sense because it saves both time and money.`
- 候选 eligible=false、source=null，不把新增原因算作用户答案。

## 迭代与验证

第一轮发现 cp09 原文已自然，取消强制输出润色的过严 fixture；补充 cp14 覆盖真正需要地道化但无需语法纠错的情况。另一轮 cp13 遇到提供方超时，原策略重跑后机器校验通过，但逐句审阅发现机械保留 every 的称呼仍不自然，因而明确 polish 可以使用意思等价的量词、单复数和句式，最小纠错仍保留原句架。

最终冻结 Prompt 后，将相同 14 个 fixtures 分为两组各 7 个，通过原 Eval CLI 的临时副本调用真实模型；只改变 fixture 目录，不改变 Schema、断言、超时、重试、模型或 Prompt。最终两组均 7/7，无需重跑失败案例；合并报告逐项断言旧／新输入完全一致。既有基线未被覆盖。

确定性测试覆盖严格 kind/source 契约、实际正文的插入／替换选择、rewrite 配合合格 corrected 的回退、pinned 与上限保护、新旧撤销文本识别和历史标签；这些业务分支不由真实模型的偶然输出代替验证。

- `pnpm lint`、`pnpm typecheck` 通过。
- `pnpm test`：822 项通过（API 559、Web 263）。
- `pnpm e2e`：30 项通过，包括批改、参考表达标签、例句正文与历史回看，及既有键盘／撤销回归。
- 格式检查和 `git diff --check` 通过。
- 独立代码审阅未发现阻断问题。

取舍：原文已经自然时不额外给一句；确实无法沿原意完成的答案显示参考表达，避免读者误认为仅是语法纠错。语言分类和质量评分仍由模型判断，14 个固定案例不代表所有输入；提供方偶发超时沿用现有重试及失败保留答案机制。
