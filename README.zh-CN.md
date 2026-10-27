# English Review（english-review）

[English](README.md) | [简体中文](README.zh-CN.md)

个人英语复习系统：Anki 轻量替代的闭环。单用户、单机、SQLite。

不是聊天家教，也不是多用户 SaaS。面向想自托管、用后端规则约束 AI 辅助的专注复习闭环。

## 能做什么

- **导入**学习材料（适合批量）
- **New Queue** 承接新词条；每日限额再进入 Today
- **Today** 是唯一正式复习入口：**理解（Understanding）** 与 **表达（Production）** 独立调度
- **AI 反馈**只做生成/判断——业务状态永远由后端决定
- **Personal Example** 沉淀有用的批改结果
- **Read** 在上下文中复现条目（不改变正式复习进度）

## 适合谁

自托管、想要小而克制的个人复习闭环的人。Coding Agent 请先读 [AGENTS.md](AGENTS.md)，不要只看本 README。

## 技术栈

| 层 | 选型 |
| --- | --- |
| Web | React + Vite + TypeScript，Tailwind + shadcn/ui |
| API | Fastify、Zod、Drizzle ORM、SQLite |
| 仓库 | pnpm monorepo（`apps/web`、`apps/api`、`packages/shared`） |

环境要求：**Node.js >= 20.19**，**pnpm 10**。

## 快速开始

```bash
pnpm install
cp .env.example apps/api/.env   # API 运行时 cwd 在 apps/api，dotenv 从这里读 .env
# 编辑 apps/api/.env：设置 AUTH_PASSWORD、SESSION_SECRET
# 可选：GLM_API_KEY / GLM_* 用于真实 AI（无 key 时 eval 可用 --provider mock）
pnpm dev                        # API 127.0.0.1:5174 + Web http://127.0.0.1:5173
```

字段说明见 [`.env.example`](.env.example)（`AUTH_PASSWORD` / `AUTH_PASSWORD_HASH`、`SESSION_SECRET`、`DATABASE_PATH`、`APP_ORIGINS`、`APP_TIMEZONE`，以及可选的 `S3_BUCKET`、`GLM_*`）。不要把真实密钥提交进仓库。

## 常用命令

```bash
pnpm test                              # 单元/集成测试（vitest）
pnpm e2e                               # Playwright E2E（自动拉起 api+web）
pnpm ai:eval -- --all                  # Prompt Eval（无 GLM key 时用 --provider mock）
pnpm ai:eval -- --task check_production
pnpm lint
pnpm format
pnpm typecheck
pnpm build                             # 类型检查 + web 构建
```

## 核心产品原则

- Simple first；**Today** 是唯一正式复习入口。
- **Learning Item** 是核心资产；题目只是可再生缓存。
- Understanding / Production 独立调度（L1–L7 阶梯 / 文档所述 FSRS）。
- New Queue 承接大批量导入，每日限额引入 Today。
- Library「练一下」与 Read **不**改变正式复习进度。
- AI 只做文本生成/判断，业务状态永远由后端决定；Prompt 正文在 Git，不入库。
- 单机、SQLite、可备份、可恢复。

## 文档地图

### 给人看

从本页（或英文 [README.md](README.md)）起步，需要时再进 `docs/`：

| 文档 | 职责 |
| --- | --- |
| [docs/PRODUCT_DESIGN.md](docs/PRODUCT_DESIGN.md) | 产品行为最高优先级：流程、页面、学习机制 |
| [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md) | 技术栈、模块/API、部署基线 |
| [docs/DATABASE.md](docs/DATABASE.md) | 数据表与生命周期 |
| [docs/AI_RULES.md](docs/AI_RULES.md) | AI 行为契约、Prompt 管理、Eval |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 前后端代码分层、全局样式/组件约束 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | TDD 开发流、测试流、lint 门禁 |
| [docs/PHASES.md](docs/PHASES.md) | 阶段划分与进度留档（进度唯一事实源） |
| [docs/MODEL_BENCHMARK.md](docs/MODEL_BENCHMARK.md) | 模型×思考基准与策略（活文档） |

产品/技术设计以中文 `docs/*` 为准；英文 README 是公开入口，不是第二份产品规格。

### 给 Coding Agent 看

1. 改代码前先读 **[AGENTS.md](AGENTS.md)**（禁区、技术栈锁定、事实源、过程纪律）。
2. 再读同一套 `docs/*` 作为权威；进度看 [docs/PHASES.md](docs/PHASES.md)。
3. 真正发给模型的 Prompt：[apps/api/prompts/](apps/api/prompts/)。
4. Prompt Eval fixtures：[apps/api/tests/ai/eval/](apps/api/tests/ai/eval/)。

不要另写一套 Agent 手册。一处事实只维护一处，用链接，不复制粘贴。

## License

[MIT](./LICENSE) — Copyright (c) 2026 timxinyao。
