# Today 会话：页面级手势 + 倒计时只触发一次 — 设计

日期：2026-09-26（phase-7 用户验收反馈修复）

## 背景

phase-7 上线后用户提出四条反馈：手势只认卡片区域、左上角"返回当前"按钮多余、回看后返回当前题时答对倒计时会重新武装并自动跳题。其中倒计时问题根源：`ActiveSession` 的自动跳题 effect 依赖 `[frozen, hold, onAdvance, cursor]`，`cursor` 从非空回到 `null` 时 effect 重跑，4 秒定时器重新开始。

## 改动

### 1. 手势区域升级为页面级（SwipeDeck / ActiveSession）

- 触摸监听从卡片内层容器上移到会话区块容器（进度行 + 卡片 + 下方留白；不含 App 顶栏）。
- 跟手 translateX/rotateY 位移动画仍只作用于卡片元素。
- 触摸起点命中交互元素时不触发手势：`closest('button, input, textarea, select, a, [role="dialog"], [data-no-swipe]')`。
- 判定参数不变：阈值 60px、|dx| > |dy|×1.5、`prefers-reduced-motion` 跳过动画。
- 结构：SwipeDeck 渲染外层手势容器 + 内层卡片位移动画目标（`data-swipe-card` ref），ActiveSession 把 ProgressRow 与卡片一并放入。

### 2. 移除"返回当前"按钮（ActiveSession）

- 删除 reviewing 态的按钮及 `ChevronLeft` import。
- 回当前路径保持既有两条：右滑越过末尾条目；列表点"当前"项。

### 3+4. 倒计时只在作答瞬间武装一次（ActiveSession）

- 保留：答对非手动推进题型且未按住时，`CORRECT_AUTO_ADVANCE_MS`(4s) 后自动下一题。
- 新增 `armedRef: FrozenAnswer | null`：effect 首次为某 frozen 对象武装定时器时记录；若 `armedRef.current === frozen`（该次作答已武装过——即中途离开后返回）则跳过，不再重置定时器。
- 中途离开（左滑回看/列表跳转）= 永久取消本次自动跳题；返回当前题后手动右滑进入下一题（答对反馈态右滑=onAdvance，现有逻辑）。
- 统一语义"一次作答最多武装一次"：按住（hold）阻断倒计时后松开同样不再重新武装。
- 跳做未完成任务并作答 = 正常的一次倒计时。

## 测试

- e2e：`today.spec.ts` 中点击"返回当前"的用例改用右滑越过末尾路径；新增"答对后回看再返回，不再自动跳题"回归用例；页面级手势用例（卡片外区域起滑可翻页、按钮/弹层起滑不翻页）。
- 手动验收：手机 PWA 上四条反馈逐条核对。

## 明确不做

- 不加倒计时视觉 UI。
- 不改 App 顶栏（手势区域不含头部）。
- 不改键盘导航语义。
