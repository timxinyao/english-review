# Phase 2 — 内容进出（Library + Import/Export + New Queue）

**状态：done · 2026-09-24 完成**（并行子 agent 模式：后端 + 前端，GLM-5.3-Flash）

## 目标

不依赖复习引擎的内容闭环：PC 导入 JSON → 预览（AI 重复建议，用户逐条确认）→ 提交 → New Queue → Library 管理 → 学习库导出。

## 实际交付

- 后端 `modules/learning-items`（列表搜索/筛选/分页、详情分组、PATCH 编辑 + 清题失效、pause/resume/archive/restore/reset/master）、`modules/questions`（`invalidateQuestions`）、`modules/import-export`（preview/commit/export）、`ai/runtime.ts`（AI 单例）。
- 前端 `features/library`：列表页（防抖搜索、筛选 chips、分页、空态）、详情页（分组例句、pin、编辑表单、progressResetSuggested 确认重置、显式操作）、三步导入向导（前端 Zod 校验 → 预览改决定 → 提交摘要）。
- 测试：后端 51 新用例（normalize、preview store、library 集成、import-export 集成）；前端 24 新用例；E2E 4 spec（导入全流程）。

## 完成标准核验

- [x] PC 导入样例 JSON 全流程 E2E 通过（粘贴→预览→改决定→提交→列表可见→详情见 source example）
- [x] 重复决策 helper / merge 语义 / commit 幂等（token 一次性）/ 搜索筛选 / round-trip 导出再导入 全部有测试
- [x] `pnpm lint && pnpm typecheck && pnpm test` 全绿（112 用例）；`pnpm e2e` 8/8
- [ ] judge_duplicate_meaning 真实模型 Eval：待 GLM_API_KEY（运维项，Phase 3 收尾时一并跑）

## 决策记录

- **reset 语义**：两维 review_states 归零 + status=active + queue_state='new'（重新进入 New Queue 走额度）+ needs_reinforcement=0。
- **merge 语义**：绝不动学习进度；候选 source/extra 例句与现有所有例句按 normalizeText 去重后追加为 extra（超软上限不报错）；tags 并集；source/sourceUrl/notes 仅原有为空时填充；用户把无匹配项改成 merge 时防御性落为 new_item。
- **列表默认隐藏 archived**（PRODUCT §3.3），显式 status=archived 可筛。
- **导出**：排除 archived；personal 例句以 corrected 文本并入 extra_examples（导入格式无 personal 字段），超 10 条截断（extras 优先）；缺 source 例句属数据完整性错误，抛 INTERNAL。
- **judge 回退**：有 GLM key 走 AI（source='ai'）；无 key 或失败 → rule_fallback merge（confidence 0.5，reason 注明）；完全重复由规则直判（rule_exact）。生产路径绝不用 mock 做语言判定。
- **preview store**：内存 Map、uuid token、TTL 2h 惰性清理、commit 一次性消费；API 重启丢失可接受（预览短生命周期）。
- **better-sqlite3 事务必须同步回调**（禁止 async/返回 Promise），事务体用 `.get()/.all()/.run()`；已写入 ARCHITECTURE.md 作为硬约束（Phase 3 answer 事务同样适用）。
- 带 default/coerce 的 Zod schema 不走 `parseBody`（签名限制），路由内直接 `.parse()`，ZodError 由 errorHandler 归一化 400。
- 前端：导入向导为 Library 页内部视图（App.tsx 仅新增 /library/:id）；列表行不显示 ipa（契约限制）；「跳过」文案区分“完全重复跳过”与“用户主动跳过”。
- `initAiRuntime` 在 buildApp 内调用（测试与生产共享初始化路径，保持 fail-fast）。

## 遗留问题（移交后续阶段）

- GLM_API_KEY 配置后跑 `pnpm ai:eval -- --all`（真实基线）与导入 AI 判定实测。
- Phase 3 接入真实题库后回归“编辑 target/meaning 清题”逻辑。
- 前端 textarea/select 升级为 components/ui 对应组件（当前用 Input 同款 token 类）。

## 变更日志

- 2026-09-24：后端/前端两个子 agent 并行开发完成；集成修复 shared type-import 与事务版本差异；全部门禁与 E2E 通过。
