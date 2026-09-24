# Prompt Eval

这个目录保存固定案例，用于让 Coding Agent 调整 Prompt 时做可重复比较。

建议未来实现 CLI：

```bash
pnpm ai:eval --task check_production
pnpm ai:eval --task generate_cloze
pnpm ai:eval --all
```

## Eval 结果至少包含

- prompt key / version / hash / model
- fixture 总数
- Schema/硬约束通过数
- changed cases（与 baseline 对比）
- Production 等有标签任务的 expected vs actual
- 需要人工审阅的输出

不要用“模型这次刚好答对”替代多案例测试；也不要为了让新版看起来更好而无理由修改 fixture 的 expected。
