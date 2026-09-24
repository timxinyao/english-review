# Prompt Eval

固定案例，用于 Prompt 调整时做可重复比较（AGENTS.md §6.2、docs/DEVELOPMENT.md §2）。

## CLI（已实现）

```bash
pnpm ai:eval -- --task check_production        # 按 task 名或 prompt_key
pnpm ai:eval -- --all                          # 全部 7 个任务
pnpm ai:eval -- --all --provider mock          # mock 模式（无需 GLM key）
pnpm ai:eval -- --task check_production --save-baseline
```

- provider 默认 `auto`：有 `GLM_API_KEY` 用真实模型，否则回落 mock。
- 基线保存在 `baselines/<prompt_key>.json`（记录每个 case 的输出摘要），再次运行时对比输出 changed cases。
- 退出码：任何 case 失败 → 非零。

## mock 模式的边界

mock provider 只验证 **Schema 与机器不变式管线**（渲染、JSON 提取、Zod、重构校验、数量/覆盖约束），不做语言判断：

- `check_production`、`judge_duplicate_meaning` 的 expected 标签对比在 mock 模式下跳过；
- 语言质量与判定准确率必须在真实模型（glm 模式）上评估。

## 每次输出包含

- prompt key / version / hash（前 12 位）/ model / provider
- fixture 总数、Schema/硬约束通过数
- changed cases（与基线对比）
- 有标签任务的 expected vs actual
- 需人工/Agent 审阅的 case（expected_invariants 中无法机器判定的条目）

不要用"模型这次刚好答对"替代多案例测试；也不要为了让新版看起来更好而无理由修改 fixture 的 expected。
