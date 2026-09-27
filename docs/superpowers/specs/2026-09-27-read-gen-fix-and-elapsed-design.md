# Read 生成失败修复 + 生成耗时显示 — 设计

日期：2026-09-27

## 背景

用户 Read 生成持续失败（502，~60s）。复现根因：真实选词 5 个 focus 弱项时，模型 coverage 漏报某项 → 不变式"focus item 未出现在 coverage"拒绝 → 3 次重试仍漏 → AiStructuredError → 502。3 个 focus 时 12.5s 成功。生产 read 文章总数为 0（从未成功过）。另有可观测性缺口：generateReadArticle 吞掉真实错误细节（未落日志）。

## 改动

### A. API：Read 生成成功率修复

1. `READ_FOCUS_MAX` 5 → 3（PRODUCT §8.1 允许 3–5；3 个显著降低 coverage 漏报率）。READ_OLD_MAX 不动。引用该常量的测试同步。
2. `apps/api/prompts/generate_read.v1.md` 强化 coverage 完整性指令：在 coverage 规则处显式加"必须逐一包含全部 focus_items 的 learning_item_id，缺一不可；写完后自查数量与 focus_items 一致"。文件名版本不变（v1 就地强化；promptHash 随内容变化按文章留档，无协议影响）。
3. `generateReadArticle` 的 catch 中先 `console.error('[read/generate]', err)` 落真实原因（AiStructuredError 细节），再抛既有通用 502 文案。

### B. Web：生成中正计时 + 完成耗时

1. 新组件 `apps/web/src/components/elapsed-timer.tsx`：`<ElapsedTimer since={ms|Date} />`，每秒跳的 `mm:ss`（超过 1 小时 h:mm:ss），不受 React 重渲染影响（内部 setInterval）。
2. ReadPage：生成中行改为"生成中 00:42…"（附 ElapsedTimer）；`generateOnce` 记录开始时间，成功回调把耗时秒数存 state，在新文章视图顶部显示小字"生成耗时 42s"。
3. StartSessionDialog：pending 态加一行 ElapsedTimer（"已等待 00:12"）。成功即关闭弹窗进入会话——**开始流程不做完成耗时显示**（弹窗消失无落点，避免为此引入 toast 体系）。

## 测试

- API 单测：buildReadSelection 的 focus 数量断言改 3；新增"生成失败时 console.error 含真实原因"用例（spy）。
- Web 单测：ElapsedTimer（fake timers：1s 跳动、mm:ss、1h 进位）；ReadPage 生成中含计时（如易测）；StartSessionDialog pending 含计时行（扩既有测试）。
- e2e：read.spec 既有用例回归（生成路径如走 fake 不受 GLM 影响）。

## 明确不做

- 不做重试时把失败原因喂回模型（self-correction，复杂度不成比例）。
- 不引入 toast 组件（耗时显示用页面内小字）。
- 不改 READ_OLD_MAX 与选词其余规则。
