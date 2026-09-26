# DEVELOPMENT.md — 开发流程与质量门禁

> 所有开发（人类或 Coding Agent）必须遵循本文。TDD 是强制要求，不是建议。

## 1. TDD 开发流（Red → Green → Refactor）

1. **Red**：先为要实现的行为写失败测试。
   - 业务规则 / 状态机 / 算法 / 工具模块 → 单元测试（`tests/unit`）。
   - API 端点 → 集成测试（`tests/integration`，fastify.inject + 临时 SQLite，先定好请求/响应契约）。
   - 用户可见流程 → E2E 测试（`apps/web/e2e`，可先 skip 标注待实现）。
2. **Green**：写最小实现让测试通过。AI 相关用 mock provider，不在单测里调真实模型。
3. **Refactor**：在绿灯下重构，测试保持通过。

禁止“先写实现再补测试”。修 bug 时先写复现该 bug 的失败测试。

## 2. 测试流（分层与职责）

| 层 | 命令 | 必须覆盖 | 不允许 |
| --- | --- | --- | --- |
| 单元/集成 | `pnpm test` | AGENTS.md §9 列出的全部领域（review 状态机、幂等、New Queue、补强、坏题撤销、导入去重、清题、Personal Example、Registry、Schema 校验） | 用真实模型调用替代确定性测试 |
| AI Eval | `pnpm ai:eval -- --all` | 任何 Prompt 正文变更（AGENTS.md §6.2 流程） | 用单元测试替代真实模型 Eval |
| E2E | `pnpm e2e` | 每个阶段新增的用户主流程 | — |
| 类型 | `pnpm typecheck` | 全部包 `tsc --noEmit` | — |

测试环境约定：

- 后端集成测试使用 `createDatabase(':memory:')` 或临时文件库，每个用例独立数据库。
- 前端组件测试 jsdom；Playwright 由 webServer 拉起真实 API（`dev:e2e`，独立 e2e.db）。
- 时间相关逻辑（调度、过期、清理）不依赖真实睡眠：以注入 clock/now 参数或直接构造时间字符串。

## 3. Lint / Format 门禁

- ESLint（typescript-eslint flat config，根目录 `eslint.config.js`）：`pnpm lint` 必须零错误。
- Prettier：`pnpm format` 格式化、`pnpm format:check` 校验；提交前必须已格式化。
- 提交前最低门禁（Agent 宣称“完成”前必须全部执行并通过）：

```bash
pnpm lint && pnpm typecheck && pnpm test
# 涉及 UI 流程：pnpm e2e
# 涉及 Prompt：pnpm ai:eval -- --task <task>（或 --all）
```

## 4. 提交与分支约定

- 小步提交，Conventional Commits（`feat:/fix:/docs:/test:/chore:/refactor:`），主题行中文或英文均可但需明确。
- 一个提交尽量只做一件事；文档变更与代码变更分开提交（纯文档同步除外）。
- 直接在 `main` 上开发（单用户项目）；重大重构前打 tag。

## 5. 每次开发的固定动作（Agent Checklist）

1. 读 `docs/PHASES.md` 与当前阶段文档，确认任务在范围内；超范围先改文档再动手（AGENTS.md §11）。
2. 按 TDD 写测试 → 实现。
3. 跑门禁（§3）。
4. 更新阶段留档：`docs/phases/phase-N-*.md` 的“变更日志/决策记录”。
5. 提交并推送。

## 6. 覆盖率态度

- 核心域（review、today、questions、import-export、prompt registry）保持高覆盖，行为规则以测试固定。
- 纯序列化/透传代码不追求覆盖率数字；不为覆盖率写无断言测试。

## 层叠与弹层规则（z-index 令牌）

- 令牌定义在 `apps/web/src/styles/globals.css` 的 `@theme inline`：`z-nav`(10) < `z-header`(20) < `z-overlay`(40) < `z-toast`(50)。
- 业务容器禁止裸写 z-index。chrome（底部导航/顶栏）与弹层只用令牌类。
- 新增任何弹层/浮层一律 `createPortal(... , document.body)` 渲染——脱离业务祖先的层叠上下文（perspective/transform 等会困住 z-index），再配 `z-overlay`/`z-toast`。
- 卡片内部局部层叠（如角标）不受此规则约束。
