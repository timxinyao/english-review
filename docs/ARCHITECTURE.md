# ARCHITECTURE.md — English Learning Tool V1.2

> 前后端代码分层、目录组织、依赖方向与全局样式/组件约束。本文是 TECHNICAL_DESIGN.md 的实现细化，冲突时以 PRODUCT_DESIGN / TECHNICAL_DESIGN 为准。

## 1. 总体依赖规则

```text
apps/web ──────┐
               ├──→ packages/shared（Zod Schema / 类型 / 常量）
apps/api ──────┘
```

- `packages/shared` 不依赖任何 app，只依赖 zod。
- `apps/web` 与 `apps/api` 互不引用。
- 后端模块之间只通过 service 层调用，不允许跨模块直连对方表。
- `apps/api/src/ai` 不 import 业务 modules；业务 modules 调用 `ai/` 暴露的 task 函数。

## 2. 后端架构（apps/api）

### 2.1 分层

```text
modules/<name>/
├── routes.ts     # 路由 + Zod 校验 + 调 service；不写业务规则
├── service.ts    # 业务规则、事务边界；通过 drizzle db 访问表
└── (可选) repo 逻辑并入 service，单用户项目不强制拆 repository
```

- **routes**：只做 parse（Zod）→ 调 service → 序列化。禁止在 routes 写 SQL 或业务判断。
- **service**：所有业务不变式（幂等、额度、补强上限、状态机、清题）在这里强制，必须事务化的写操作用 `db.transaction`。
- **db/**：drizzle schema、migration、client 工厂（`createDatabase(path)` 便于测试用临时库）。
- **ai/**：promptRegistry、taskConfig、provider（glm/mock）、completeStructured（JSON 提取 + Zod + 语义校验 + 重试）。
- **jobs/**：定时任务入口，只调用 service，不写 SQL。
- **lib/**：与业务无关的通用件（errors、session cookie、http helpers、logger）。

### 2.2 依赖方向

```text
routes → service → db / ai / shared
ai → shared（AI 输出 Schema）、prompts/*.md（经 Registry）
jobs → service
任何层不得绕过 service 直接 UPDATE review_states（AGENTS.md §5）
```

### 2.3 错误与响应约定

- 成功：直接返回数据对象（camelCase）。
- 失败：`{ "error": { "code": "STABLE_ERROR_CODE", "message": "简短可读" } }`。
- 业务错误抛 `AppError(code, message, statusCode)`；Zod 校验失败统一 `VALIDATION_ERROR` 400；未捕获错误 500 且只写日志，不泄漏堆栈/SQL/模型细节。
- 时间：DB 存 UTC ISO 8601 字符串；API 出入参 ISO 8601；`session_date` 等“用户本地日期"按 `APP_TIMEZONE`（默认 Asia/Shanghai）归属。

### 2.4 配置与密钥

- 全部来自环境变量（`src/config.ts` 用 Zod 校验，缺非法值启动即失败）。
- 访问密码：`AUTH_PASSWORD`（或 `AUTH_PASSWORD_HASH=盐:哈希` scrypt）；只存哈希，DB 不存密码。
- 会话：HMAC 签名无状态 Cookie（`el_session`，HttpOnly、SameSite=Lax、生产 Secure、30 天），无 session 表。
- GLM Key 只在服务端 env；修改型接口做 Origin 白名单检查（`APP_ORIGINS`）。

### 2.5 运行形态

- 开发与生产都用 `tsx src/index.ts` 直跑 TypeScript（单用户单机项目，接受该开销；`build` 仅做 `tsc --noEmit` 类型检查）。
- 启动顺序：config → migration → Prompt Registry 校验（fail fast）→ listen。

## 3. 前端架构（apps/web）

### 3.1 目录与职责

```text
src/
├── app/            # 应用级：providers（QueryClient/Router）、AppShell、路由守卫
├── styles/         # globals.css —— 全局样式唯一来源（见 3.2）
├── components/ui/  # 全局基础组件库（button/input/label/...，shadcn 风格）
├── features/<name>/# 按功能聚合：components/、hooks/、api.ts（query keys + 请求函数）
│   ├── today/  ├── library/  ├── read/  ├── stats/  └── settings/
├── lib/            # api client（fetch 封装）、cn、tts 等纯工具
└── main.tsx / App.tsx
```

- feature 内组件不得定义新的主题色/间距基准；视觉全部来自 tokens 与 `components/ui`。
- 跨 feature 复用的组件升级到 `components/`（全局）或下沉 `lib/`（无 UI 工具）。
- 服务端状态只用 TanStack Query；禁止引入全局 store 保存业务数据。

### 3.2 全局样式（唯一来源）

`src/styles/globals.css`：

- Tailwind v4 CSS-first：`@import "tailwindcss"` + `@theme inline` 把 CSS 变量映射为工具类（`bg-background`、`text-foreground`、`border-border`、`text-accent`…）。
- Design tokens（色彩/圆角/字体）以 `:root` CSS 变量定义，取值遵循 PRODUCT_DESIGN §12：暖白背景、深灰文字、低饱和暖色强调、细边框、极少阴影。
- 语义 token 清单（新增颜色必须先加 token，再使用工具类）：
  `background / foreground / card / muted / muted-foreground / accent / accent-foreground / border / input / destructive / success / diff-delete / diff-insert`。
- **禁止**在 feature 代码里写 hex 颜色、任意阴影、内联 style 样式；需求无法用现有 token 表达时，先扩展 tokens。

### 3.3 请求与数据流

- `lib/api.ts`：唯一 fetch 封装（credentials: include、JSON、错误归一化为 `ApiError{code,message}`、401 交给调用方跳登录）。
- 每个 feature 的 `api.ts` 定义 query key 常量与请求函数；组件只消费 hooks。
- 请求/响应 DTO 用 `packages/shared` 的 Schema，不重复定义。

### 3.4 路由与壳

- React Router；`RequireAuth` 依赖会话探针 query（GET /api/settings），401 跳 `/login`。
- AppShell：手机底部导航 + PC 左侧导航（Today/Library/Read 为主，Stats/Settings 次要入口），一页一个主动作。

## 4. 测试架构

| 层 | 工具 | 位置 | 用途 |
| --- | --- | --- | --- |
| 单元 | vitest | `apps/api/tests/unit`、`apps/web/tests` | 纯函数、lib、组件渲染 |
| 集成 | vitest + fastify.inject | `apps/api/tests/integration` | API 契约、事务、幂等（临时 SQLite） |
| AI Eval | `pnpm ai:eval` | `apps/api/tests/ai/eval` | Prompt + fixtures + 机器不变式 |
| E2E | Playwright | `apps/web/e2e` | 每阶段用户可见主流程（拉起真实 api+web） |

- 后端测试的 AI 一律走 mock provider，保证确定性；真实模型只在 ai:eval 里用。
- 详见 docs/DEVELOPMENT.md。
