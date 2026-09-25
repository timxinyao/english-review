# MODEL_BENCHMARK.md — 模型 × 思考强度基准（活文档）

> 用途：记录每次「模型 × 思考强度」基准测试的结果与由此确定的 taskConfig 策略，供后续换模型/新模型（DeepSeek 等）对比参考。**新跑一轮就追加一节，不改旧数据。**
>
> 当前生效策略与最近一次结论见 §1；历史数据按日期倒序在 §3。

## 1. 当前生效策略（taskConfig，2026-09-25 起）

| 任务 | 模型 | 思考档 | 依据（2026-09-25 基准） |
| --- | --- | --- | --- |
| checkProduction（表达批改） | **glm-5.3（主模型）** | medium(4096) | 18/18=100% · 14s；flash 各思考档最高 16/18=89% 且 25s+；两模型 off 档均 12/18=67%（思考是批改刚需） |
| checkCloze（填空兜底判定） | glm-5.3-flash | off | 12/12=100% · 2.3s |
| judgeDuplicateMeaning（导入重复） | glm-5.3-flash | low(2048) | 9/9=100% · 7.2s（off 8/9） |
| generateUnderstandingQuestions | glm-5.3-flash | off | off 即 100%（main）/~75%+重试兜底（flash）；思考档纯增延迟 |
| generateClozeQuestions | glm-5.3-flash | off | off=100% · 5.4s；思考档超时劣化（flash/high 仅 50%） |
| generateProductionPrompt | glm-5.3-flash | off | 100% · 4.6s |
| generateRead | glm-5.3-flash | off | 100% · 16.9s（2 样本，坏文由 coverage 不变式重试兜底） |

全局覆盖：`GLM_THINKING=off|low|medium|high|max` 强制所有任务；`GLM_MODEL_FLASH/AIR/MAX` 固定具体型号（留空=按 `/v1/models` 自动选最新）。

## 2. 方法论（复现方式）

```bash
cd apps/api
# 全矩阵（7 任务 × 2 模型 × 4-5 档，判定类 3 轮 / 生成类 2 轮独立调用，间隔 1.5s，无重试）
pnpm exec tsx scripts/ai-bench.ts --max-minutes 90
# 只跑部分任务 / 自定义模型列表（label=id 逗号分隔）
pnpm exec tsx scripts/ai-bench.ts --only checkProduction,judgeDuplicateMeaning --max-minutes 55
pnpm exec tsx scripts/ai-bench.ts --models flash=glm-5.3-flash,ds=deepseek-chat
```

- 口径：**首次通过率**（无重试）= Schema 校验 + 机器不变式 + 期望标签（判定类）三者全过；生成类无标签，仅前两项。
- temperature 用各任务策略值；延迟含网络往返；原始数据在 `apps/api/scripts/bench/results-*.jsonl`。
- 判定类任务的期望标签来自 `tests/ai/eval/fixtures/*.sample.json` 的 `expected` 字段——新模型若判错，先核对是不是 fixture 该更新。

## 3. 历史结果

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

### （未来模型对比在此追加，如：2026-XX-XX · DeepSeek）

## 4. 换模型对比指南（DeepSeek 等）

provider 走 Anthropic Messages 兼容协议，换模型**只需配置**：

1. DeepSeek 的 Anthropic 兼容端点：`GLM_API_BASE=https://api.deepseek.com/anthropic`、`GLM_API_KEY=<ds key>`（env 注入，勿提交）
2. 跑基准：`pnpm exec tsx scripts/ai-bench.ts --models ds=deepseek-chat,ds-r=deepseek-reasoner --max-minutes 90`
   - DeepSeek 的思考模型（reasoner）自带推理：thinking 档对它传 budget 可能无效/报错——若报错，用 `--models` 单测 off 档即可，把"自带思考"记入对比结论
3. 结果追加到 §3（同表格式），与 GLM 行对比通过率/延迟
4. 若某任务新模型胜出且要切换：改 `taskConfig` 的 alias 指向（或 `GLM_MODEL_*` env 固定型号）→ 跑 `pnpm ai:eval -- --all` → 更新 §1 并在本文件留档

注意：模型自动发现（`/v1/models`）目前按 `glm-*` 命名规则解析；非 GLM 端点请用 `GLM_MODEL_FLASH/AIR/MAX` 显式指定型号（自动发现会回退到 fallback 常量）。
