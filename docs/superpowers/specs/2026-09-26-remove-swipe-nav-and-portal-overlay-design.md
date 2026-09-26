# 移除滑动导航 + 弹层 Portal 层叠方案 — 设计

日期：2026-09-26 晚（用户三项验收反馈第 2、3 条 + 第 1 条结论留档）

## 背景

- 用户反馈：① 回看返回后倒计时又触发；② 左右滑做成上一题/下一题"逻辑很乱，先删了"；③ 单词列表弹层被菜单遮住，希望全局性解决（防再犯）。
- ① 的事实结论：用户设备自 16:57 起停留在 10:43 构建（当时 `sw.js 404`——上午部署被冻结打断所致——设备无 Service Worker，此后 phase-7 与手势/倒计时修复部署均未送达）。① 即已修复的 armedRef bug 的旧版表现；修复已在线上，设备重新打开应用（联网）即可拿到新版验证。本设计不改倒计时语义。
- ③ 的现行代码隐患：页面级手势重构给会话区块容器加了 `perspective`，它创建层叠上下文，把任务列表弹层的 `z-40` 困在里面——顶栏(z-20)/底部导航(z-10) 会画在弹层之上。删滑动后 perspective 随 SwipeDeck 消失，此雷自动排除；但仍需全局规则防再犯。

## 改动

### 1. 删除滑动导航（全删，列表为唯一导航入口）

- 删除 `apps/web/src/features/today/components/SwipeDeck.tsx` 与 `apps/web/tests/swipe-deck.test.tsx`。
- `ActiveSession`：根容器回归普通 `div.space-y-4`；删除 `handleSwipeLeft/Right`、键盘 ←/→ effect、`later.mutate` 的 UI 触发（API 与 `useLater` 保留，暂无入口，留档）。
- 导航只剩列表点击（既有语义不变）：已完成项=回看（只读）；未做项=跳做（可作答）；"当前"项=回当前。未答题跳过=列表点下一个未做项。
- 倒计时不变：答对当前题武装一次（armedRef），列表跳走即永久取消。
- 清理 `data-swipe-area` / `data-swipe-card` / touch-action 相关样式与引用。

### 2. 弹层 Portal + z-index 令牌（全局层叠规则）

- z-index 令牌：`z-nav=10`、`z-header=20`、`z-overlay=40`、`z-toast=50`，以 Tailwind 主题扩展或 `globals.css` 工具类形式集中定义；shell 顶栏/底部导航与任务列表弹层改用令牌。
- 任务列表弹层（ProgressRow 内 dialog）改 `createPortal(document.body)` 渲染——脱离任何祖先层叠上下文，永远位于 chrome 之上。React 合成事件沿组件树冒泡，弹层内 `stopPropagation` 关闭逻辑不受影响（测试覆盖）。
- 规则留档进 `docs/DEVELOPMENT.md`：新增任何弹层/浮层一律 portal 到 body + 使用 z 令牌，禁止在业务容器上写 z-index。

### 3. 测试改写

- 注：jsdom 下 `fireEvent.click(document.body)` 不会触发 portal 子树 onClick（React 合成事件沿组件树派发，portal 容器无 fiber）——遮罩关闭断言应 fire 在弹层根节点上。
- 单测 `today-navigation.test.tsx`：swipeBy/键盘导航用例改列表路径；倒计时两用例的"左滑回看/右滑回当前"改为列表跳转与点"当前"项。
- e2e `today.spec.ts`：删除手势用例与 `touchSwipe` helper；倒计时用例改列表导航；既有"导航"用例（列表回看/跳做）保留。

## 上线后用户复核（三项）

1. 回看/跳转返回后不触发倒计时（需设备先拿到新版：联网重开应用即可，无 SW 也能 HTTP 拿最新 index）。
2. 无任何滑动翻页与键盘导航，列表是唯一导航。
3. 列表弹层不被顶栏/底部菜单遮挡。

## 明确不做

- 不做 AppShell ModalHost 模板化（方案 B）。
- 不加"稍后再做"UI 按钮（后续有需要再加）。
- 不改 `CORRECT_AUTO_ADVANCE_MS` 与 armedRef 语义。
