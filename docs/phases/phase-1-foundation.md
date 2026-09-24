# Phase 1 — 工程地基（Foundation）

**状态：done · 2026-09-24 起，2026-09-24 完成**

## 目标

可一键安装运行的 pnpm monorepo；数据库全量 schema 与 migration；认证；Prompt Registry + AI Provider（GLM + Mock）；Eval CLI；前端全局主题与 App Shell；TDD/测试/E2E/lint 全套基础设施。冻结数据契约与 AI 契约。

## 实际交付范围

1. 设计包落仓 + 文档缺口补丁（ipa、daily_stats、API 端点、production fixture）+ ARCHITECTURE / DEVELOPMENT / PHASES 文档 + AGENTS.md 更新（阶段留档、TDD 强制、前端全局样式约束）。
2. Monorepo：root 配置（eslint flat / prettier / tsconfig.base / workspace）、三个包（@el/shared、@el/api、@el/web）。
3. `packages/shared`：复习常量与默认参数、11 张表实体 Schema、导入/导出契约、7 个 AI 任务输出 Schema + 任务目录 + segments 重建工具。
4. `apps/api`：config（Zod env 校验）、Drizzle 全量表 + migration、HMAC 无状态 Cookie 会话、auth/settings/health、Origin 白名单、结构化错误；Prompt Registry（严格 frontmatter、文件名-版本一致、SHA-256 hash、严格变量、fail-fast）、taskConfig（flash/air/max 别名）、GLM/Mock provider、completeStructured（JSON 提取 + Zod + 语义不变式 + 重试）、`pnpm ai:eval` CLI（基线对比）。
5. `apps/web`：Tailwind v4 CSS-first tokens（暖白/深灰/低饱和暖橙）、components/ui（button/input/label）、AppShell（手机底部导航 + PC 侧栏）、登录页、RequireAuth 路由守卫、五个 feature 占位页（Settings 展示真实数据）。
6. 测试：API 单元（frontmatter 7、registry 9、session 5）+ 集成（auth 7、settings 3、migration 2）= 34；web 组件 3；Playwright E2E 4（登录全流程）。

## 数据表（已建全量，本阶段写入 settings）

learning_items, learning_examples, review_states, review_sessions, review_tasks, questions, attempts, read_articles, read_article_items, settings, daily_stats

## API（已实现）

`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/health`、`GET/PATCH /api/settings`

## 完成标准核验

- [x] `pnpm i && pnpm dev` 同时起 api+web（api 5174 / web 5173，代理 /api）
- [x] `pnpm lint && pnpm typecheck && pnpm test` 全绿（37 用例）
- [x] `pnpm e2e` 登录流程通过（4 spec）
- [x] `pnpm ai:eval -- --all --provider mock` 全绿（7 任务；基线已存 baselines/）
- [x] 坏 Prompt 文件导致 API 启动失败（fail-fast 已实测）
- [x] 文档与 AGENTS.md 已含 TDD/留档/架构/全局样式约束
- [x] 额外：`vite build` 生产构建通过

## 决策记录

- 生产与开发都用 tsx 直跑 TS（`build` 只做类型检查）：单用户单机项目，换取零构建漂移。
- 密码只从 env（AUTH_PASSWORD / AUTH_PASSWORD_HASH scrypt）校验，DB 不存任何密码材料；会话为 HMAC 无状态 Cookie，无 session 表；登出即客户端清 Cookie（已记录为单用户方案的接受项）。
- shared 包以 TS 源码直接被 api(tsx)/web(vite) 消费，不做 dist 构建。
- GLM 模型经别名（flash/air/max）映射 env 可覆盖：生成类 flash、判定/批改/Read 用 air。
- drizzle extraConfig 用对象形式（0.36.4 类型约束）；原生句柄经 WeakMap 暴露（rawSqlite）。
- mock provider 只保证 Schema/不变式管线确定性；语言判定类任务（check_production、judge）在 mock 模式跳过 expected 标签对比——真实评估必须用 glm 模式。
- Eval 基线存 `tests/ai/eval/baselines/<prompt_key>.json`（case → 输出摘要），用于 changed cases 对比。
- 前端 tokens 全部集中于 `apps/web/src/styles/globals.css`（含 diff-delete/diff-insert 预留）。

## 遗留问题（移交后续阶段）

- GLM_API_KEY 未配置：真实模型 Eval 待用户提供 key 后执行（Phase 2 结束时跑 judge_duplicate_meaning，Phase 4 结束时跑 check_production）。
- PWA manifest / vite-plugin-pwa 留待 Phase 6。
- Stats 页仅有入口占位，数据在 Phase 6。

## 变更日志

- 2026-09-24：阶段启动，范围确定。
- 2026-09-24：完成全部范围；37 单测 + 4 E2E + mock Eval 7 任务全绿；lint/typecheck/build 通过；提交并推送。
