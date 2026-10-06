# 2026-10-06 · check_production v3（思考纪律）

## 背景与诊断

切换 DeepSeek flash 后（docs/MODEL_BENCHMARK.md §3 2026-10-06 节），cp13（`wlecome to every honored guests in our wedding.`，拼写+搭配双陷阱）思考跑飞 65-79s，在生产 35s 超时下永远无法批改——手动重试同样被截断，该类句子成为"不可批改"死角。

直连端点抓取思考原文（39,367 字符 / 45s 样本）：开头几百字即完成全部核心判断（typo、every+复数、basic_pass 定级），后半篇幅全是 `# Final Check` 8 条清单触发的**重复自审循环**（result 再确认、corrected 两种写法来回比较、候选 source 重查），不是在解题。

## v3 变更（唯一改动）

Role 节后新增：

> **Thinking Discipline**：按顺序一次做完：评分 → 纠错 → 润色 → 例句候选。每个判断在证据到手时即定案，之后不回头重审或重新论证已定结论；Final Check 每条只核对一次，不反复循环。全部规则已在本文档给出，直接执行即可，不需要穷举其他可能的解读。

其余 v2 内容一字未动（最小变更原则，便于归因）。

## 实验结果（thinking max · deepseek-flash）

- 全量 14 例 × 2 轮：27/28（唯一失败 cp12 segments 重建，聚焦复测 ×4 全过 → 判定为噪声；两轮合计准确率 35/36）
- **cp13：65-79s → 37-65s**（6 样本中位 ~48s，↓ 约 35%）
- 全量 avg 12.8s / p50 6.8s（v2 基准 13.8s / 6.3s，持平）

## 配套超时链放宽（apps/api taskConfig + apps/web lib/api）

| 参数 | 旧 | 新 | 理由 |
| --- | --- | --- | --- |
| checkProduction timeoutMs | 35s | **60s** | attempt1=min(60, 预算/2)=60s，覆盖 cp13 中位 48s |
| totalBudgetMs | 80s | **120s** | 支撑 60s 首试 + 两次裁剪重试，仍 < nginx 180s |
| 前端 REQUEST_TIMEOUT | 100s | **150s** | > 预算 120s+ε，不误伤慢批改（原 80s 预算同理） |

代价：双重失败最坏等待 ~120s（原 ~80s），仅影响疑难句失败路径；正常句子 p50 6.8s 无感。

## 结论

思考纪律节对 DeepSeek 思考模式的"清单驱动重复自审"有实测抑制作用（尾巴 ↓35%），准确率无损；配合超时链放宽，cp13 型疑难句 5/6 样本可在 attempt1 直接批出，"不可批改死角"消除。

复现：`EXP_ONLY=cp12,cp13 EXP_RUNS=4 pnpm -C apps/api exec tsx apps/api/scripts/cp-discipline-exp.mts`（校验口径同 ai-bench：Schema+不变式+expected）。
