# Phase 6 — 统计、备份恢复、清理与部署

**状态：planned**

## 目标

收尾全部产品/技术 DoD：Stats + 12 个月热力图、完整备份/覆盖恢复、生命周期清理任务、S3 日备份、Nginx HTTPS + systemd + PWA、全部 Prompt 真实 Eval 报告。

## 模块

`stats`、import-export 的 backup/restore、jobs（weekly-cleanup、monthly-maintenance、daily-backup）、PWA（vite-plugin-pwa）、部署配置（nginx conf、systemd unit/timer、部署脚本）。

## API

`GET /api/stats`、`GET /api/export/backup`、`POST /api/restore/preview`、`POST /api/restore/commit`

## 测试点

- Stats：核心数字口径（总项/类型/状态/New Queue/近 7 天任务/表达通过率/近 30 天新增）来自 daily_stats。
- restore：预览（时间/数量/当前数据量）、二次确认、恢复前自动快照、维护锁内执行、备份含 settings+daily_stats。
- 清理 job 幂等：retired 45 天且库存足、bad_question 30 天、普通 Read 30 天、attempts 明细 60 天（保留每 Item 最近 10 次表达/voided/已入 personal example 例外）、review_tasks/sessions 12 个月。
- S3 上传与 30 天轮转（aws-cli 脚本）。
- E2E/手动 smoke：login → Today → Library → health；PC/手机 PWA 跨设备续接。

## 完成标准

- PRODUCT_DESIGN §13 与 TECHNICAL_DESIGN §18 DoD 清单逐条通过。
- 7 个 Prompt 真实模型 Eval 全量对比报告归档（docs/phases/ 或 apps/api/tests/ai/eval/baselines）。

## 决策记录

（暂无）
