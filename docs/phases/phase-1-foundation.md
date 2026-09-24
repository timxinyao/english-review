# Phase 1 — 工程地基（Foundation）

**状态：in-progress · 起始 2026-09-24**

## 目标

可一键安装运行的 pnpm monorepo；数据库全量 schema 与 migration；认证；Prompt Registry + AI Provider（GLM + Mock）；Eval CLI；前端全局主题与 App Shell；TDD/测试/E2E/lint 全套基础设施。冻结数据契约与 AI 契约。

## 范围

1. 设计包落仓（docs/、prompts/、fixtures/、AGENTS.md、README）+ 文档缺口补丁（ipa、daily_stats、API 端点、production fixture）+ 新增 ARCHITECTURE / DEVELOPMENT / PHASES 文档。
2. 根工作区：package.json、pnpm-workspace.yaml、tsconfig.base、ESLint(flat)、Prettier、.gitignore、.env.example。
3. `packages/shared`：常量（复习阶梯/默认参数/清理保留期）+ Zod Schema（全部实体表、导入 JSON v1.2、7 个 AI 任务输出、auth/settings API）。
4. `apps/api`：config（env+Zod）、db（drizzle 全表 + migration + client 工厂）、auth（密码登录/HMAC Cookie/Origin 检查）、settings（GET/PATCH）、health、错误处理、结构化日志。
5. `apps/api/ai`：frontmatter 解析、promptRegistry（load/校验/hash/严格变量/fail-fast）、taskConfig（模型别名映射）、provider（glm/mock）、completeStructured（JSON 提取+Zod+重试）、机器不变式。
6. `pnpm ai:eval` CLI：fixtures 加载、mock/glm 双模式、基线对比、汇总输出。
7. `apps/web`：Vite+React+TS+Tailwind v4（CSS-first tokens）、components/ui（button/input/label）、AppShell（手机底部/PC 侧边导航）、登录页、路由守卫、五个 feature 占位页（Settings 显示真实数据）。
8. 测试：api 单元（frontmatter/registry/session）+ 集成（auth/settings/migration 冒烟）；web 组件冒烟；Playwright E2E 登录流程。

## 数据表（本阶段建全量，仅开始写入 settings）

learning_items, learning_examples, review_states, review_sessions, review_tasks, questions, attempts, read_articles, read_article_items, settings, daily_stats

## API

`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/health`、`GET/PATCH /api/settings`

## 测试点

- frontmatter 严格解析（缺 key/坏 version/未知字段报错）
- Registry：7 个真实 Prompt 加载、key 唯一、文件名 .vN 与 frontmatter 一致、hash 稳定、renderPrompt 缺变量报错、坏文件 fail-fast
- session token：签发/过期/篡改拒绝、timing-safe
- auth 集成：未登录 401、错密码 401 稳定文案、登录后可访问、登出失效、Origin 白名单
- settings 集成：默认值、PATCH 校验（额度枚举、content_level 枚举）
- migration 冒烟：空库 → 全部表存在
- eval CLI mock 模式全绿
- web：Button 渲染/变体、登录页 E2E（错误密码报错、正确密码跳 Today）

## 完成标准

- [ ] `pnpm i && pnpm dev` 同时起 api+web
- [ ] `pnpm lint && pnpm typecheck && pnpm test` 全绿
- [ ] `pnpm e2e` 登录流程通过
- [ ] `pnpm ai:eval -- --all --provider mock` 全绿
- [ ] 坏 Prompt 文件导致 API 启动失败（fail-fast）
- [ ] 文档与 AGENTS.md 已含 TDD/留档/架构/全局样式约束

## 决策记录

- 生产与开发都用 tsx 直跑 TS（`build` 只做类型检查）：单用户单机项目，换取零构建漂移。
- 密码只从 env（AUTH_PASSWORD / AUTH_PASSWORD_HASH scrypt）校验，DB 不存任何密码材料；会话为 HMAC 无状态 Cookie，无 session 表。
- shared 包以 TS 源码直接被 api(tsx)/web(vite) 消费，不做 dist 构建。
- GLM 模型经别名（flash/air/max）映射，env 可覆盖；check_production/generate_read 默认 air，生成类默认 flash。
- Tailwind v4 CSS-first，tokens 全部在 `apps/web/src/styles/globals.css`。

## 变更日志

- 2026-09-24：阶段启动，范围确定。
