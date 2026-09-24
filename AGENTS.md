# AGENTS.md — English Learning Tool V1.2

本文件约束 Coding Agent / AI Agent 的开发行为。开始修改代码前必须先阅读 `docs/PRODUCT_DESIGN.md`、`docs/TECHNICAL_DESIGN.md`、`docs/DATABASE.md`、`docs/AI_RULES.md`、`docs/ARCHITECTURE.md`、`docs/DEVELOPMENT.md` 与 `docs/PHASES.md`。

## 1. 文档与事实源

1. `docs/PRODUCT_DESIGN.md`：业务行为最高优先级。
2. `docs/TECHNICAL_DESIGN.md`：技术实现基线。
3. `docs/DATABASE.md`：数据结构。
4. `docs/AI_RULES.md`：AI 行为、Prompt 与 Eval 契约。
5. `docs/ARCHITECTURE.md`：前后端代码分层、目录、依赖方向与全局样式/组件约束。
6. `docs/DEVELOPMENT.md`：TDD 开发流、测试流、lint 与提交门禁。
7. `docs/PHASES.md` + `docs/phases/*.md`：阶段划分与进度留档（进度唯一事实源）。
8. `apps/api/prompts/*.md`：真正发送给模型的 Prompt 正文。
9. 本文件：开发过程约束。

本项目只维护 Markdown；**不要创建或同步 Word/DOCX 版本。**

发现冲突时不要自行猜测。优先保持产品规则，并显式修正文档、Prompt、Schema 或代码。

## 1A. 阶段留档（强制）

- 动手前：读 `docs/PHASES.md` 与当前阶段留档，确认任务在阶段范围内；超范围先按 §11 改文档再动手。
- 收尾时：更新对应 `docs/phases/phase-N-*.md` 的变更日志与决策记录；阶段完成时逐条勾选完成标准并把 `docs/PHASES.md` 状态改为 done。
- 任何对既定范围的扩大/缩减、对设计文档的偏离，都必须写入该阶段“决策记录”，注明理由。

## 2. 禁止擅自增加的能力

- 不新增独立 Practice 页面。
- 不新增手工新增 Learning Item 入口（PC Import 除外）。
- 不新增注册、多账号、OAuth、找回密码。
- 不新增离线业务数据同步。
- 不新增 Streak、排行榜、成就、复杂游戏化。
- 不新增聊天/查词助手、STT、发音评分。
- 不新增 RAG、Agent workflow、向量数据库。
- 不新增 Redis、消息队列、微服务。
- 不因“看起来更现代”切换技术栈。
- 不建设 Prompt 管理后台，除非产品文档先明确增加该需求。

## 3. 技术栈不可随意替换

固定：React + Vite + TypeScript、Tailwind + shadcn/ui、React Router、TanStack Query、Fastify、Zod、Drizzle、SQLite、pnpm monorepo。

除非技术文档先被明确修改，否则不要引入 Next.js、NestJS、Prisma、PostgreSQL、Redis、Kubernetes 等替代方案。

## 4. 代码组织

- 前端按 feature 组织；不要建立全项目级 `services/` 大杂烩。
- 后端按业务 module 组织；不要把所有 controller/service/repository 横向拆散。
- 公共 request/response/AI Schema 放 `packages/shared`。
- 不复制 Zod Schema。
- AI provider / registry / task 代码放 `apps/api/src/ai`。
- Prompt 正文只放 `apps/api/prompts/*.md`。
- Job 只能调用业务 service，不直接绕过业务层写数据库。

## 5. 业务规则不能被 UI 或 AI 绕过

以下规则必须由后端强制：

- Today task 只能结算一次。
- Understanding / Production Stage 只能由 review service 修改。
- 每日新学习额度。
- 每个 Item 每 Session 最多 2 道 reinforcement。
- Library “练一下”不改变正式 Stage。
- Read 不直接改变 Stage。
- pinned Personal Example 不得自动淘汰。
- bad question 必须撤销该题造成的学习影响。
- target / meaning 修改必须使相关 fresh/active 题失效。

AI 不得直接决定或返回要写入的 Stage、next_review_at、mastered、queue_state。

## 6. Prompt 开发规则

### 6.1 禁止事项

- 不在 TypeScript 中新增大段 inline Prompt。
- 不把 Prompt 正文写入数据库。
- 不绕过 Prompt Registry 直接读取另一个 Prompt 副本。
- 不仅凭一两个手工例子宣布 Prompt “优化完成”。
- 不修改 Prompt 后忘记版本与 Eval。

### 6.2 修改 Prompt 的标准流程

1. 确认要改变的是语言行为，而不是应该由业务代码控制的规则。
2. 修改对应 `apps/api/prompts/*.md`。
3. 若输出结构变化，先同步 Zod Schema 与 `AI_RULES.md`。
4. 在固定 fixtures 上运行对应 Prompt Eval。
5. 对比旧版/新版 changed cases。
6. 修正明显回归。
7. 将 frontmatter `version` +1。
8. 提交 Prompt、测试/fixture 变化和简短 Eval 摘要。

任何真正发送给模型的 Prompt 正文变化，发布时都必须增加版本号，并将文件名从 `.vN.md` 同步改为 `.vN+1.md`；运行时目录只保留一个当前版本，历史由 Git 保留。`prompt_hash` 由程序自动计算，禁止人工伪造。

### 6.3 Prompt 评审输出

当用户要求“调一下 Prompt 并测试效果”时，Agent 最少应报告：

- 修改了哪个 `prompt_key`；
- 旧版与新版版本号；
- 跑了多少 fixtures；
- 哪些 case 结果发生变化；
- 是否存在已知 trade-off；
- 是否建议发布。

## 7. 数据与删除

- Learning Item 不物理删除；使用 archived。
- 派生数据按生命周期删除。
- 新增数据库字段前先判断是否是长期核心数据。
- 可以再生成的信息优先放派生表或 question payload，不污染 learning_items。
- Prompt 正文不是业务数据，不进 DB；只存 prompt metadata。

## 8. AI 调用

- 所有输出必须 Schema 校验后才能入库。
- AI 不能直接返回 HTML 用于 diff。
- 不把模型调用细节暴露给前端。
- Prompt Registry 负责模板加载、变量校验、version/hash。
- Production、Question、Read 等可追溯实体必须记录实际 prompt metadata。

## 9. 测试要求：TDD 强制

所有开发遵循 `docs/DEVELOPMENT.md` 的 Red → Green → Refactor 流程：

- 业务规则 / 状态机 / 工具模块：先写失败测试，再写实现；修 bug 先写复现测试。
- API 端点：先写集成测试固定契约（fastify.inject + 临时 SQLite）。
- 用户可见新流程：补 Playwright E2E。
- 单元/集成测试中的 AI 一律用 mock provider；真实模型只在 ai:eval 中使用。
- 宣称“完成”前必须通过：`pnpm lint && pnpm typecheck && pnpm test`；涉及 UI 流程加 `pnpm e2e`；涉及 Prompt 加 `pnpm ai:eval`。

涉及以下代码的修改必须补测试：

- review state machine
- Today answer / 幂等 / 并发
- New Queue
- reinforcement
- bad question rollback
- Import duplicate handling
- question invalidation
- Personal Example pinned replacement
- Prompt Registry 加载/缺失变量/hash
- AI Schema validation

Prompt 修改必须跑对应 Eval fixtures；不要用普通单元测试替代真实模型 Eval，也不要用真实模型 Eval 替代确定性单元测试。

## 9A. 前端全局样式与组件约束

- 设计 tokens（颜色/圆角/字体）唯一来源是 `apps/web/src/styles/globals.css`；新增视觉语义必须先加 token。
- 基础组件唯一来源是 `apps/web/src/components/ui/`；feature 代码复用它们，不重复实现。
- 禁止在 feature 代码中写 hex 颜色、任意阴影、内联 style；禁止建立第二套样式体系。
- 服务端状态只用 TanStack Query；不引入全局业务 store。
- 目录与依赖方向遵循 `docs/ARCHITECTURE.md` §3，前后端分层遵循其 §2/§3。

## 10. UI 约束

- Quiet UI，一页一个主动作。
- 不为了丰富页面增加无用统计卡片。
- 不使用大量颜色、渐变、阴影。
- Word 显示 IPA；Chunk 不显示 IPA。
- PC 与手机共享同一功能语义，只改变布局。

## 11. 修改文档的规则

如果需求会改变用户可见行为：

1. 先修改 `PRODUCT_DESIGN.md`；
2. 必要时同步 `TECHNICAL_DESIGN.md / DATABASE.md / AI_RULES.md`；
3. 再改代码、Prompt 和测试。

如果只是 Prompt 措辞优化且不改变产品契约，只改 Prompt + Eval 即可；如果 Prompt 输出字段或判定规则变化，必须同步 `AI_RULES.md` 和 Schema。

如果只是内部重构且不改变行为，不需要修改产品文档。
