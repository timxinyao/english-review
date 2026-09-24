# English Learning Tool V1.2 — english-review

个人英语复习系统：替代 Anki 的轻量复习闭环（导入 → New Queue → Today 复习 → 理解/填空/表达 → AI 批改 → Personal Example → Read 上下文复现）。单用户、单机、SQLite。

## 文档地图（阅读顺序）

| 文档 | 职责 |
| --- | --- |
| [docs/PRODUCT_DESIGN.md](docs/PRODUCT_DESIGN.md) | 产品行为最高优先级：流程、页面、学习机制 |
| [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md) | 技术栈、模块/API、部署基线 |
| [docs/DATABASE.md](docs/DATABASE.md) | 数据表与生命周期 |
| [docs/AI_RULES.md](docs/AI_RULES.md) | AI 行为契约、Prompt 管理、Eval |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 前后端代码分层、全局样式/组件约束 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | TDD 开发流、测试流、lint 门禁 |
| [docs/PHASES.md](docs/PHASES.md) | 阶段划分与进度留档（进度唯一事实源） |
| [AGENTS.md](AGENTS.md) | Coding Agent 开发纪律 |
| [apps/api/prompts/](apps/api/prompts/) | 真正发送给模型的 7 个 Prompt（Git 为源） |
| [apps/api/tests/ai/eval/](apps/api/tests/ai/eval/) | Prompt Eval fixtures |

## 快速开始

```bash
pnpm install
pnpm dev            # 同时启动 api(127.0.0.1:5174) 与 web(5173)
```

首次运行前复制 `.env.example` 为 `apps/api/.env` 并设置 `AUTH_PASSWORD`、`SESSION_SECRET`（开发有默认值）。

## 常用命令

```bash
pnpm test           # 全部单元/集成测试（vitest）
pnpm e2e            # Playwright E2E（自动拉起 api+web）
pnpm ai:eval -- --all              # Prompt Eval（无 GLM key 时用 --provider mock）
pnpm ai:eval -- --task check_production
pnpm lint           # ESLint
pnpm format         # Prettier
pnpm typecheck      # tsc --noEmit
pnpm build          # 类型检查 + web 产物构建
```

## 核心产品原则

- Simple first；Today 是唯一正式复习入口。
- Learning Item 是核心资产，题目只是可再生缓存。
- Understanding / Production 独立调度（L1–L7 阶梯）。
- New Queue 承接大批量导入，每日限额引入。
- Library“练一下”与 Read 不改变正式复习进度。
- AI 只做文本生成/判断，业务状态永远由后端决定；Prompt 正文在 Git，不入库。
- 单机、SQLite、可备份、可恢复。
