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
| 6 | 统计/备份/部署 | Stats+热力图、备份恢复、清理任务、Nginx/systemd/S3、PWA | done（2026-09-25，部署待域名/桶名） | [phase-6-ops.md](phases/phase-6-ops.md) |

> **V1.2 六个阶段全部完成（2026-09-25），已部署上线**：https://18-136-183-11.nip.io（HTTPS+PWA）与 http://18.136.183.11:8080 双入口。剩余可选优化见 phase-6 留档"遗留问题"。

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
| 2026-09-25 | Agent 对话式导入：`apps/api/scripts/import-cli.ts`（登录→preview→commit，与 PC 导入页同一 API 契约）+ `.agents/skills/import-english` skill；契约修正 decisions 允许空数组（=全按系统建议）。不新增产品入口——仍是唯一导入 API，"最终由用户确认"不变 | 用户要求：通过和 Agent 对话导入 |
| 2026-09-25 | 思考强度档位 off/low/high/max（budget 2048/6144/16384）：任务策略（判定批改 low、生成 off）+ GLM_THINKING 全局强制 + Settings 展示 | 用户要求；实测端点支持 thinking 与 temperature 同用 |
| 2026-09-25 | 备份双模式：S3_BUCKET 设置=异地容灾；默认**本地轮转**（snapshots/daily-<日期>.db 30 天 + monthly-<年月>.db 12 个月，按文件名日期整日判定） | 用户确认无 S3；S3 变为可选 |
| 2026-09-25 | **正式部署上线**：IP+8080 HTTP 直访（现有 nginx conf.d 加站点，443 与现有服务共存不动）+ COOKIE_SECURE 开关；后经 nip.io 免费域名 + Let's Encrypt 升级 HTTPS（https://18-136-183-11.nip.io），Cookie Secure 改按 X-Forwarded-Proto 自适应（双入口并存），PWA/Service Worker 解锁；systemd api + 4 timers 生效 | 用户要求：无域名无证书上线、后升级 HTTPS |
| 2026-09-25 | iOS 主屏 Web App：SVG 图标（暖橙几何 E.）→ Chromium 导出 favicon/180/192/512；apple-touch-icon + apple-mobile-web-app-* 元数据；全面屏安全区 pb-safe/pt-safe-lg + 顶栏刷新按钮（invalidateQueries 不打断会话） | 用户要求 |
| 2026-09-25 | el-cli 统一管理 CLI（import-cli 并入：preview/commit + find/show/set/archive/restore/pause/resume/reset/master/stats/backup）+ `.agents/skills/library-english`（先查→告知后果→确认→执行；"删除"=归档）；errorHandler 修复框架级 4xx 误报 500 | 用户确认两 skill 方案，生产 12 步实测通过 |
| 2026-09-25 | 模型×思考全矩阵基准（7 任务×2 模型×4-5 档，判定 3 轮/生成 2 轮独立调用无重试）定策略：生成类全 flash+off（思考档超时劣化）、cloze 判定 flash+off、judge flash+low、批改唯一例外 main+medium（100%·14s vs flash 最高 89%）；发现并修复 GLM"不传 thinking=自发思考"（off 必须显式 disabled，65s→9s）。报告：apps/api/scripts/bench/2026-09-25-summary.md；新策略全量 Eval 20/20 | 用户要求实测排列组合 |
