# MODEL_BENCHMARK.md — 模型 × 思考强度基准（活文档）

> 用途：记录每次「模型 × 思考强度」基准测试的结果与由此确定的 taskConfig 策略，供后续换模型/新模型（DeepSeek 等）对比参考。**新跑一轮就追加一节，不改旧数据。**
>
> 当前生效策略与最近一次结论见 §1；历史数据按日期倒序在 §3。

## 1. 当前生效策略（taskConfig，2026-10-06 起 · DeepSeek）

全线 `deepseek-flash`（用户指定不用 v4-pro），Anthropic 兼容端点（§3 2026-10-06 节）：

| 任务 | 模型 | 思考档 | 依据（2026-10-06 基准） |
| --- | --- | --- | --- |
| checkProduction（表达批改） | deepseek-flash | **max** | 42/42=100% · avg 13.8s · p50 6.3s；端点忽略 budget_tokens，max 档真实作用是 max_tokens 上限 24576（消灭思考打满上限的「缺文本」失败）；off 86% 有系统性判错；prompt v3 思考纪律后疑难句 37-65s，timeoutMs 60s/预算 120s/前端 150s 链路覆盖 |
| checkCloze（填空兜底判定） | deepseek-flash | off | 沿用（GLM off 已 100%；DeepSeek flash off 更强） |
| judgeDuplicateMeaning（导入重复） | deepseek-flash | off | 9/9=100% · 1.0s（GLM 时代 off 8/9 才补 low，DeepSeek off 即满过） |
| generateUnderstandingQuestions | deepseek-flash | off | 沿用（生成类 off 即最优） |
| generateClozeQuestions | deepseek-flash | off | 沿用 |
| generateProductionPrompt | deepseek-flash | off | 沿用 |
| generateRead | deepseek-flash | off | 沿用 |

全局覆盖：`GLM_THINKING=off|low|medium|high|max` 强制所有任务；`GLM_MODEL_FLASH/AIR/MAX` 固定具体型号（留空=按 `/v1/models` 自动选最新）。

## 2. 方法论（复现方式）

```bash
cd apps/api
# 全矩阵（7 任务 × 2 模型 × 4-5 档，判定类 3 轮 / 生成类 2 轮独立调用，间隔 1.5s，无重试）
# ⚠ 成本防误触：全矩阵 ≈742 次真实调用（按 token 计费数元），脚本预估 >300 次要求显式 --yes
pnpm exec tsx scripts/ai-bench.ts --yes --max-minutes 90
# 只跑部分任务 / 自定义模型列表（label=id 逗号分隔）——日常调参用这个，单任务×单模型仅几毛钱
pnpm exec tsx scripts/ai-bench.ts --only checkProduction,judgeDuplicateMeaning --max-minutes 55
pnpm exec tsx scripts/ai-bench.ts --models flash=glm-5.3-flash,ds=deepseek-chat
```

- 口径：**首次通过率**（无重试）= Schema 校验 + 机器不变式 + 期望标签（判定类）三者全过；生成类无标签，仅前两项。
- temperature 用各任务策略值；延迟含网络往返；原始数据在 `apps/api/scripts/bench/results-*.jsonl`。
- 判定类任务的期望标签来自 `tests/ai/eval/fixtures/*.sample.json` 的 `expected` 字段——新模型若判错，先核对是不是 fixture 该更新。

## 3. 历史结果

### 2026-10-06 · DeepSeek 切换（deepseek-flash，Anthropic 兼容端点，全线唯一模型）

**端点事实（实测）**：`GLM_API_BASE=https://api.deepseek.com/anthropic` + x-api-key 协议全兼容，provider 代码零改动。①**budget_tokens 被忽略**——thinking 档位只起"开/关"作用，档间差异仅来自 max_tokens 上限（budget + GLM_MAX_TOKENS）；②`/v1/models` 404 → `GLM_MODEL_*` 必须显式指定；③不传 thinking 默认开思考，off 必须显式 disabled（glm.ts 原有逻辑直接适用）。价格（每百万 token，人民币）：输入 1/2 元（空闲/高峰）、输出 4/8 元，thinking 按输出计价；v4-pro 4.5/9 与 13.5/27（未用）。

**checkProduction**（14 例 × 3 轮 = 42 次/档，无重试）：

| 档位（=max_tokens 上限） | 首过率 | avg | p50 | max | 失败模式 |
| --- | --- | --- | --- | --- | --- |
| off | 36/42=86% | **1.2s** | — | 1.6s | cp06/cp12 系统性判错（各 3/3 重复，重试救不回） |
| low（10240） | 39/42=93% | 12.6s | — | 53.4s | cp13 思考打满上限「缺文本」×3 |
| medium（12288） | 40/42=95% | 12.9s | — | 63.3s | cp13 缺文本 ×1 + cp07 invariant ×1（偶发） |
| high（14336） | 40/42=95% | 12.7s | — | 66.2s | cp13 缺文本 ×2 |
| **max（24576）** | **42/42=100%** | 13.8s | **6.3s** | 78.6s | 0 |

延迟分布（max 档）：<5s 31% · <15s 74% · <35s **90.5%** · >35s 9.5%（几乎全为 cp13 疑难句 65-79s，生产 35s 超时截断+单次重试兜底）。

**judgeDuplicateMeaning**（3 例 × 3 轮）：**off/low/medium/high/max 全部 9/9=100%**，off 仅 1.0s——判定 off 即最优，策略从 GLM 时代的 low 回落到 off。

**本轮结论**：① checkProduction 定档 **flash+max**（100% · 13.8s，胜 GLM main+medium 的 94% · 15s）；② DeepSeek flash off 底子远强于 GLM flash off（批改 86% vs 67%，judge 100% vs 89%）；③ cp13 型疑难句思考跑飞（34-79s）是思考模式固有长尾，靠 max_tokens 大上限保成功、靠超时重试保体验；④ v4-pro 按用户指定不启用（bench 首轮已跑即停）。

**2026-10-06 追加 · 思考纪律实验（prompt v2→v3）**

背景：cp13 型疑难句（`wlecome` 拼写 + `every`+复数双陷阱）思考跑飞 65-79s，35s 超时下**永远无法批改**（手动重试同样被截断）。抓思考原文（39k 字符）发现：核心判断开头几百字已完成，后半全是 Final Check 8 条清单触发的重复自审循环。

v3 变更：Role 后新增「Thinking Discipline」节——四个判断按序一次做完、每个判断一次定案不回头重审、Final Check 每条只核对一次、规则已给全不穷举其他解读。

| 指标 | v2 | v3 |
| --- | --- | --- |
| 通过率（thinking max） | 42/42（bench） | 35/36（cp12 一例 invariant 失败为噪声：聚焦复测 4/4 清白） |
| cp13 延迟 | 65-79s | 37-65s（6 样本中位 ~48s） |
| avg / p50（全量） | 13.8s / 6.3s | 12.8s / 6.8s |

配套放宽超时链（否则 v3 收益被 35s 截断吃掉）：checkProduction timeoutMs 35→**60s**、totalBudgetMs 80→**120s**、前端 REQUEST_TIMEOUT 100→**150s**（nginx 180s 不动；attempt1=min(60, 预算/2)=60s 覆盖 cp13 中位，5/6 直接批出）。复现脚本：`apps/api/scripts/cp-discipline-exp.mts`（EXP_ONLY/EXP_RUNS 环境变量过滤用例与轮数）。

### 2026-10-03 · GLM checkProduction 复测（用户反馈批改变慢；部分档位受时间预算截断）

| 组合 | 首过率 · 延迟 | 备注 |
| --- | --- | --- |
| flash/off | 12/18=67% · avg 4.4s | 与 09-25 一致 |
| flash/low | 16/18=89% · avg 20.3s | max 35.3s |
| flash/medium | 2/3 · avg 25.4s（截断） | max 57.5s |
| main/off | 15/18=83% · avg 3.4s | 较 09-25 的 67% 略升，仍不足 |
| main/low | 15/18=83% · avg 21.4s | 含一次 120s provider 超时 |
| **main/medium** | **17/18=94% · avg 15.0s** | 唯一失败为 JSON 解析错（生产端有 2 次结构化重试兜底）；max 37.2s |
| main/high | 9/10=90% · avg 14.9s（截断） | — |

另：ai:eval 当前配置 6/6 通过但该轮平均 ~25s（样本方差大）。

**本轮结论**：① main+medium 仍是最优组合，策略**不变**；② 平均延迟与 09-25 基本持平（15s vs 14s），但**方差明显变大**（max 37s、偶发 120s 超时），"感觉变慢"来自长尾与 GLM 侧波动；③ flash 准确率依旧 ≤89%，继续排除。

### 2026-09-25 · GLM（glm-5.3-flash vs glm-5.3，Anthropic 兼容端点）

| 任务 | flash/off | flash/low | flash/med | flash/high | flash/max | main/off | main/low | main/med | main/high | main/max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **checkProduction**（18例） | 67% · 5.5s | 89% · 27.9s | 83% · 25.6s | 89% · 25.4s | 78% · 26.3s | 67% · 3.1s | **100% · 16.1s** | **100% · 14.0s** | 94% · 14.1s | 100% · 14.0s |
| checkCloze（12例） | **100% · 2.3s** | 92% · 7.2s | 100% · 7.0s | 100% · 7.0s | 100% · 7.0s | 100% · 2.0s | 100% · 4.2s | 100% · 4.9s | 100% · 4.9s | 100% · 4.4s |
| judgeDuplicate（9例） | 89% · 2.4s | **100% · 7.2s** | 100% · 7.7s | 100% · 8.1s | 100% · 7.4s | 100% · 2.1s | 100% · 5.2s | 100% · 5.8s | 100% · 5.4s | 100% · 5.3s |
| genUnderstanding（4例） | 75% · 9.3s | 100% · 75.1s | 100% · 76.1s | 100% · 65.5s | — | 100% · 7.0s | 75% · 50.4s | 100% · 45.2s | 100% · 39.2s | — |
| genCloze（4例） | **100% · 5.4s** | 75% · ⚠ | 100% · 70.3s | 50% · ⚠ | — | 100% · 4.0s | 100% · 65.2s | 100% · 65.5s | 100% · 72.1s | — |
| genProductionPrompt（4例） | **100% · 4.6s** | 100% · 56.4s | 100% · 59.8s | 100% · 65.5s | — | 100% · 2.5s | 100% · 21.0s | 100% · 28.9s | 100% · 31.2s | — |
| generateRead（2例） | **100% · 16.9s** | 100% · 99.2s | 50% · ⚠ | 100% · 89.3s | — | 50% · 9.7s | 100% · 53.3s | 100% · 44.2s | 0% · 36.8s | — |

⚠ = 出现 120s provider 超时。read 每组合仅 2 次调用，趋势供参考。

**本轮结论**：① 生成类 off 即最优，思考档纯增延迟甚至超时劣化；② 简单判定 flash 足够；③ 批改必须"强模型+思考"（main+low/medium/max=100%，flash 全档 ≤89%），off 档两模型均 67% 说明思考与模型无关地刚需；④ 实时交互延迟红线 20s（main/medium 14s 达标，flash 思考档 25s+ 出局）。

**附带发现（已修复）**：GLM Anthropic 端点**不传 thinking 参数时模型会自发思考**（实测 flash 单次自发 ~10k 字符 → 65s+ 延迟）。off 档必须显式 `thinking: {type:'disabled'}`（65s→9s）。换任何 Anthropic 兼容端点时都要复核此行为。

### （未来模型对比在此追加）

## 4. 换模型对比指南（2026-10-06 DeepSeek 切换实操版）

provider 走 Anthropic Messages 兼容协议，换模型**只需配置**（本次实证：代码零改动）：

1. DeepSeek 的 Anthropic 兼容端点：`GLM_API_BASE=https://api.deepseek.com/anthropic`、`GLM_API_KEY=<ds key>`（env 注入，勿提交）。模型名：`deepseek-flash` / `deepseek-v4-pro`
2. 跑基准：`pnpm exec tsx scripts/ai-bench.ts --only <task> --models flash=deepseek-flash --max-minutes 50`
   - **budget_tokens 被该端点忽略**：thinking 档位间唯一差异是 max_tokens 上限（budget+GLM_MAX_TOKENS）；思考打满上限会「缺文本」失败，档位越高越免疫
   - 思考模式有固有长尾（疑难句 60s+），评估时要看 p50/max 分布而非只看 avg
3. 结果追加到 §3（同表格式），与旧行对比通过率/延迟
4. 若某任务新模型胜出且要切换：改 `taskConfig` 的 alias/thinking → 跑 `pnpm ai:eval -- --all` → 更新 §1 并在本文件留档

注意：模型自动发现（`/v1/models`）在该端点 404 且解析规则按 `glm-*` 命名——非 GLM 端点必须用 `GLM_MODEL_FLASH/AIR/MAX` 显式指定型号。
