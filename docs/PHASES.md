# PHASES.md — 阶段划分与进度留档

> 本文是开发进度的唯一事实源。每阶段有独立留档文件 `docs/phases/phase-N-*.md`（目标、范围、测试点、完成标准、决策记录、变更日志）。开始工作前先读当前阶段文档；完成或变更后立即更新留档。

## 阶段总览

| Phase | 名称 | 目标一句话 | 状态 | 留档 |
| --- | --- | --- | --- | --- |
| 1 | 工程地基 | Monorepo/DB/认证/Prompt Registry/AI Provider/测试与 lint 基础 | done（2026-09-24） | [phase-1-foundation.md](phases/phase-1-foundation.md) |
| 2 | 内容进出 | Import→New Queue→Library 管理→导出（含 AI 重复判定） | done（2026-09-24） | [phase-2-content.md](phases/phase-2-content.md) |
| 3 | 复习引擎与 Today | 状态机、Session、理解/填空题、补强、坏题撤销 | done（2026-09-24） | [phase-3-review.md](phases/phase-3-review.md) |
| 4 | 表达与个人例句 | 表达题生成/实时批改/diff、Personal Example、练一下 | done（2026-09-24） | [phase-4-production.md](phases/phase-4-production.md) |
| 5 | Read | 阅读生成、检查题、needs_reinforcement 闭环 | done（2026-09-25） | [phase-5-read.md](phases/phase-5-read.md) |
| 6 | 统计/备份/部署 | Stats+热力图、备份恢复、清理任务、Nginx/systemd/S3、PWA | planned | [phase-6-ops.md](phases/phase-6-ops.md) |

状态取值：`planned / in-progress / done / blocked`。

## 留档规则

1. 阶段开始：把状态改为 in-progress，写明起止时间与实际范围。
2. 过程中：重要工程决策、对设计文档的偏离及理由，记入“决策记录”。
3. 阶段结束：对照完成标准逐条勾选，状态改 done，写总结与遗留问题。
4. 范围变更：任何超出/缩减本阶段范围的决定都要在留档中显式记录原因。

## 全局决策记录（跨阶段有效）

| 日期 | 决策 | 依据 |
| --- | --- | --- |
| 2026-09-24 | 采用六阶段计划（上表）；B 类工程决策按分析报告默认值执行（间隔减半规则、补强插入位置、Learn 完成时翻 queue_state 等） | 设计包审查确认 |
| 2026-09-24 | 文档缺口补齐：import JSON 增加 ipa、新增 daily_stats 表、practice 作答与 master 端点、generate_production_prompt fixture | 设计包审查确认 |
| 2026-09-24 | TDD 强制、阶段留档、前后端架构文档、全局样式/组件约束写入 AGENTS.md 与 docs/ | 用户要求 |
| 2026-09-24 | APP_TIMEZONE 默认 Asia/Shanghai；TTS voice 按设备存 localStorage；后端生产用 tsx 直跑 | 用户确认的工程决策 |
| 2026-09-25 | GLM 接入切换 Anthropic Messages 兼容端点；模型自动发现（留空=按 /v1/models 选最新 flash/主模型，env 指定优先，失败回退内置常量）；`GET /api/ai/models` + Settings 只读展示 | 用户要求：模型号随 code plan 演进需自动适配、可配置覆盖、界面可见 |
| 2026-09-25 | 思考强度档位 off/low/high/max（budget 2048/6144/16384）：任务策略（判定批改 low、生成 off）+ GLM_THINKING 全局强制 + Settings 展示 | 用户要求；实测端点支持 thinking 与 temperature 同用 |
