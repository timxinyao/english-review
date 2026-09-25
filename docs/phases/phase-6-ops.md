# Phase 6 — 统计、备份恢复、清理与部署

**状态：done · 2026-09-25 完成**（三并行子 agent：后端 stats+备份恢复 / 后端 jobs+部署设施 / 前端 Stats+PWA；GLM-5.3-Flash）

## 目标

收尾全部产品/技术 DoD：Stats + 12 个月热力图、完整备份/覆盖恢复、生命周期清理任务、S3 日备份（含轮转）、Nginx/systemd/PWA 部署设施、全部 Prompt 真实 Eval 报告。

## 实际交付

**Stats（modules/stats）**：`GET /api/stats`——总览（items 含 archived、按 type/status、New Queue）、近 7 天正式任务、表达通过率（null 安全）、近 30 天新增、**365 天热力图**（APP_TIMEZONE 归属、零填充、旧→新）。

**备份恢复（import-export 扩展）**：`GET /api/export/backup`（精确 BackupExport：items+examples+双维进度+daily_stats+settings，attachment）；`POST /api/restore/preview`（Zod 全量校验 + 一次性 token + warnings）；`POST /api/restore/commit`（**恢复前原生一致性快照** → 同步事务按外键顺序覆盖 → 保留原 id；AI 缓存与 Read 不还原）。round-trip 测试：破坏库后完整还原。

**清理/备份 jobs（src/jobs）**：
- weekly-cleanup：retired 45 天且库存足才删、bad_question 30 天、过期 Read 级联删、attempts 60 天（voided 与每 item 最新 10 次表达例外）、tasks/sessions 12 个月；幂等
- daily-backup：原生快照 → S3（daily/ 前缀）→ **本地临时即删** → 30 天轮转；monthly 12 个月轮转；无桶降级本地保留一份 + warn
- monthly-maintenance：表膨胀告警（只报不删）+ 月度备份

**部署设施（deploy/）**：systemd（api 常驻 + prefetch/backup/cleanup/maintenance 的 service+timer，04:00/05:00/Sun 03:00/每月 1 日 02:00，Persistent）、nginx 模板（80 可跑 + 443 注释待 certbot、/api 反代、SW no-cache、gzip）、幂等 deploy.sh、上线 checklist README（env 清单/恢复演练）。`nginx -t` 与 `systemd-analyze verify` 已验证语法。

**前端**：StatsPage（dl 行式总览 + GitHub 风格热力图：四档 token 色阶、月份标签、横向滚动、图例）；Settings 备份区（导出 blob 下载、三步恢复向导：前端 Zod 初校验 → preview 红字覆盖警示 → destructive 二次确认 → commit 后 reload；PC-only）；PWA（vite-plugin-pwa autoUpdate、manifest、python 生成图标、**不设 navigateFallback 不拦截 /api**，SW 产物已确认）。

## 完成标准核验（产品 DoD §13 →）

- [x] PC 导入 JSON + 预览逐条处理；大批量入 New Queue（Phase 2）
- [x] Today 每日额度，旧复习不受限（Phase 3）
- [x] Learn 页 + U/P 独立调度（Phase 3/4）
- [x] 选择/填空/表达题可完成；选择题展示随机化（Phase 3/4）
- [x] 表达题实时批改 + diff + pinned/unpinned Personal Example（Phase 4）
- [x] 👎 撤销学习影响入 bad_question；单 Item 单 Session ≤2 补强（Phase 3）
- [x] Library"练一下"不改正式进度；无独立 Practice 页（Phase 4）
- [x] Read 180–400 词；答错只标记下次补强不改 Stage（Phase 5）
- [x] PC/手机同一服务端数据、可续接、重复提交不重复结算（幂等测试 + 无状态会话；真机续接 smoke 待部署后）
- [x] Library 全文搜索/固定筛选/编辑/暂停/恢复/归档（Phase 2）
- [x] Stats 核心数字 + 12 个月热力图（本阶段）
- [x] 浏览器 TTS 朗读词与例句（Phase 3/5）
- [x] 学习库 JSON、完整备份 JSON、覆盖式恢复可用（本阶段，round-trip 测试）
- [x] 题目/Read/日志按生命周期自动清理（job 已实现；**定时调度随部署启用**）
- [x] Prompt 仓库管理、生成/批改可追溯 prompt 版本（Phase 1+，ai_prompt_* 落库）

## 完成标准核验（技术 DoD §18 →）

- [x] 一键安装、分别启动 web/api
- [x] 共享 Zod Schema，无重复 DTO
- [x] migration 空库建全 Schema（含 0001/0002）
- [x] Today answer 事务与幂等测试
- [x] 定时任务可手工运行；systemd timer 已交付（启用随部署）
- [x] S3 日备份与恢复演练：备份 job 实测（无桶降级路径）；**S3 实桶上传与 30 天轮转待用户提供桶名后启用**；恢复演练（快照+round-trip）已测试
- [x] AI 输出全 Schema 校验，失败不落库
- [x] Prompt Registry 启动校验；发布包含 prompts 资产（deploy.sh rsync 全量）
- [x] Eval fixtures 可重复运行；真实模型全量 **7 任务 20/20**（glm-5.3 / glm-5.3-flash，基线在 baselines/）
- [ ] Nginx + HTTPS + PWA 正常使用：**配置与模板就绪，域名/证书/桶名待用户输入后一键上线**
- [x] 核心行为与 PRODUCT_DESIGN 一致（14 个 E2E 覆盖主流程）

## 决策记录

- 恢复的并发安全用**同步事务边界**（单连接单事务天然排斥并发写），不建显式维护锁；快照在事务外、恢复前执行（backup API 异步 + 事务回调必须同步的约束下唯一正确顺序）。
- 备份/恢复区 PC-only（与导入一致）；恢复前快照命名 `backup-before-restore-<ts>.db` 存 DB 同级 snapshots/。
- 清理边界统一闭区间（`<= now-Nd`）；S3 轮转严格早于（30 天整保留）；双向边界有测试。
- 热力图 ≥20 档色阶用 `bg-accent opacity-80`（token 约束下）；图例四档。
- PWA 不设 navigateFallback（仅 precache 静态资产），/api 永不经 SW。
- 无 S3_BUCKET 时备份降级本地单份 + warn（timer 不持续报错）。
- stats 口径：items/words/chunks 含 archived（备份完整性优先），页面加注脚说明。

## 遗留问题（上线待办，需用户输入）

1. **域名 + DNS** → certbot 签发 → 启用 nginx 443 段（deploy/README.md 步骤）。
2. **S3 桶名**（`S3_BUCKET`）→ 日/月备份与轮转自动生效。
3. 生产 `/etc/english-learning/env`（强 SESSION_SECRET、AUTH_PASSWORD 或 scrypt HASH、GLM_API_KEY）。
4. 真机（手机 PWA）跨设备续接 smoke。
5. snapshots/ 目录的历史快照积累由 monthly-maintenance 顺带清理的策略，真实使用后再定。

## 变更日志

- 2026-09-25：三子 agent 并行交付（stats/备份 18 测试、jobs/部署 31 测试、前端 32 测试 + PWA）；集成全量门禁：api 391 + web 132 用例、E2E 14/14、真实 Eval 7 任务 20/20、PWA 构建产物确认。
