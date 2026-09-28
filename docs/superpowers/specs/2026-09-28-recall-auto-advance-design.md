# Recall 评分即前进（Auto Advance）设计

日期：2026-09-28
状态：已确认（用户批准）

## 1. 背景与动机

Recall 自评路径（learn 新词初见 + understanding 复习）的交互是：显示答案 → 自评「想起来了 / 没想起来」→ 冻结反馈页 → 手动点「下一题」。

反馈页只是把自评前已展示过的释义 + 原句再摆一遍、加一行判语，多按一次「下一题」是纯摩擦，与产品原则「低摩擦」（PRODUCT §2.1）相悖。

## 2. 范围

**改**：Recall 自评路径（learn / understanding 的「想起来了 / 没想起来」两键）。

**不改**：

- Hint 选择题路径（ChoiceQuestionCard 的 correct/wrong 反馈含答案与解析、其实是蒙的/太简单了入口，是核心学习内容）；
- 填空（cloze）、表达（production）的反馈页；
- 回看（readOnly）模式；
- 后端 API（纯前端改动）。

## 3. 交互定义

- 点「想起来了 / 没想起来」→ 提交成功 → 等待 `/api/today` refetch 成功 → 自动进入下一题；若是最后一题，进入完成摘要页。
- refetch 失败 → 停留在现有冻结反馈页（RecallFeedback），“下一题”按钮与“坏题”入口仍在，作为人工兜底。
- 不引入人工延迟（短停顿方案已被用户否决）；按钮 pending 态沿用现有 `disabled={answer.isPending}`。

## 4. 技术方案

### 4.1 数据流：autoAdvance 标记

不能“提交成功后立刻 advance”：自动前进快于 refetch 时，`data.currentTask` 仍是旧题，旧题卡会闪回来并短暂回到可作答状态。因此前进必须以 refetch 成功为前提。

- `FrozenAnswer` 增加 `autoAdvance?: boolean`（`apps/web/src/features/today/components/ActiveSession.tsx`）。
- `RecallCard` 的 `onAnswered` 签名扩展为 `(result: AnswerResponse, opts?: { autoAdvance?: boolean }) => void`；自评两键提交成功时回调 `onAnswered(result, { autoAdvance: true })`。
- `TaskCard` 透传 opts；`ActiveSession.handleAnswered` 把 opts 并入 `FrozenAnswer` 传给 `onAnswered`。
- Hint 路径（ChoiceQuestionCard）与回看路径不带该标记，行为不变。

### 4.2 TodayPage 前进时机

```tsx
const advance = useCallback(() => setFrozen(null), []);
useEffect(() => {
  if (frozen?.autoAdvance) void refetch().then(advance).catch(() => {});
}, [frozen]);
```

- refetch resolve → `advance()`（清 frozen）→ 新数据渲染下一题 / 完成页；
- refetch reject → 不前进，frozen 反馈页兜底（吞掉 rejection，不产生 unhandled rejection）；
- effect 依赖 `frozen` 对象身份，refetch 失败后不会重复触发；用户手动“下一题”照旧可用。

### 4.3 坏题与误评撤销

自动前进后，Recall 题的「坏题」入口从（不再展示的）反馈页转移到既有路径：**任务列表 → 点已完成条目回看 → 坏题**（回看模式本就渲染坏题按钮与冻结反馈）。

顺手修复：回看模式下 `ActiveSession` 给 TaskCard 传的 `onAdvance` 为 undefined，坏题成功后 `onAdvance?.()` 是 no-op、界面停在已撤销条目上。改为：

```tsx
onAdvance={reviewing ? () => setCursor(null) : onAdvance}
```

坏题成功后返回当前题。副作用：回看旧题时冻结页的“下一题”按钮行为 = 返回当前题，语义成立。

### 4.4 涉及文件

- `apps/web/src/features/today/components/RecallCard.tsx`（签名 + 两键回调）
- `apps/web/src/features/today/components/TaskCard.tsx`（透传）
- `apps/web/src/features/today/components/ActiveSession.tsx`（FrozenAnswer 类型、handleAnswered、reviewing 分支 onAdvance）
- `apps/web/src/features/today/TodayPage.tsx`（autoAdvance effect）
- `docs/PRODUCT_DESIGN.md` §7.1（流程描述）

## 5. 文档更新

PRODUCT_DESIGN.md §7.1 流程图之后补一句：

> 评分即前进（2026-09-28 实现更新）：自评提交成功即自动进入下一题——刷新落地前用预取队列乐观渲染下一题（末题短暂占位），后台静默对账；刷新失败停留在反馈页（下一题/坏题兜底）。误评可在 任务列表 → 回看 → 坏题 撤销本次影响。

## 6. 测试计划（TDD）

- `apps/web/tests/today-recall.test.tsx`：点「想起来了」→ 断言不再出现“下一题”按钮的稳态（onAnswered 收到 `autoAdvance: true`）；
- `apps/web/tests/today-navigation.test.tsx`：
  - refetch 成功 → 渲染下一题 / 完成页（mock useTodayStatus refetch resolve）；
  - refetch 失败 → 停留反馈页且有“下一题”按钮（mock reject）；
- 回看坏题：回看模式标记坏题成功后返回当前题；
- 回归：Hint 路径、填空、表达题的“下一题”按钮行为不变；
- `apps/web/e2e/today.spec.ts`：recall 自评后无需额外点击即见下一题。

## 7. 决策记录

- 不采用“全部题型自动前进”：选择题/表达题反馈页含答案解析与反馈入口，删除属功能损失。
- 不采用“短停顿后自动前进”：增加节奏等待，用户已否决。
- 前进时机绑定 refetch 成功而非固定延时：消除旧题闪回与二次作答窗口。
