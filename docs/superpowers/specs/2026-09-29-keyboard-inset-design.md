# iOS 键盘避让设计（全局 --kb-inset 机制）

> 2026-09-29 真机修正：下列初版 `--kb-inset` 方案在 iOS 出现 `innerHeight=visualViewport.height=389`、`offsetTop=423`、`scrollY=423` 时把键盘误判为关闭。修复以 `TECHNICAL_DESIGN.md` §7.6 为准：键盘状态独立于 inset，Today 只按可视视口高度计算一次卡高，并保持页面顶部位置；旧方案保留在此作为失败机制记录。
>
> 2026-09-29 动画修正：聚焦时把整个页面壳改为 fixed、键盘高度过 100px 才切换卡高，会造成中间帧闪动；现以 `TECHNICAL_DESIGN.md` §7.6 的稳定页面壳与连续卡高为准。
>
> 2026-09-29 主屏 PWA 录屏再修正：整页跟随 `visualViewport.offsetTop` 平移同样会闪动（WebKit offset 更新晚于屏幕平移）。现移除整页 transform；填空/表达触屏先将 dock 预置到键盘安全高度，再无滚动聚焦。此策略需实机验收，不能由桌面 E2E 证明动画手感。
>
> 2026-09-29 聚焦时序修正：上条“触屏先预置”在真机使键盘短暂出现后消失。完整触摸诊断发现 pointerdown 中真实输入从 y≈585 移到 y≈231，随后 click 命中 main。改为保留原生触摸聚焦，click 落在真实输入后才移动 dock；不再抢焦点。
>
> 2026-09-29 真机诊断修正：键盘稳定时 `scrollY=107`，顶栏恰上移 107px；卡高约 390px 与 `visualViewport.height=389` 已匹配。当前以真实 document `scrollY` 同步校正 Today 页面壳和独立 fixed 顶栏，不依赖异步 `visualViewport.offsetTop`。以 `TECHNICAL_DESIGN.md` §7.6 为准。
>
> 2026-09-29 动画复验：上条 `scrollY` 同步校正重新造成抖动，已撤回。当前以触摸 `pointerdown` 原位 `focus({preventScroll:true})` 预防系统滚动，保持输入命中区域到 click 完成后才缩卡；见 `TECHNICAL_DESIGN.md` §7.6。

## 意图与验收

iPhone（Safari/主屏 PWA）在 Today 答题聚焦输入框时，软键盘不得把整个页面顶起：顶栏与题干保持可见不动，输入框与提交按钮贴键盘上沿，题干/反馈区压缩滚动；收起键盘恢复原布局。document 不发生滚动位移。其他页面行为不变。Android Chromium 顺带获得一致的布局收缩行为。

## 机制设计

- 新模块 `apps/web/src/lib/keyboard-inset.ts`：单例监听 `window.visualViewport` 的 `resize` 与 `scroll`（模块级守卫，只安装一次），计算 `inset = max(0, round(window.innerHeight - vv.height - vv.offsetTop))`，写入 `<html>` 元素 style 的 `--kb-inset`（键盘收起时归 0）。同时以 `useSyncExternalStore` 暴露 `useKeyboardInset(): number` 供 React 消费数值。`window.visualViewport` 不存在时安全 no-op（返回 0、不绑监听）。写入不做节流过渡（键盘动画期间的连续 resize 每次直接写，CSS 变量写入本身廉价）。
- `apps/web/src/app/shell.tsx` 挂载一次该 hook，全站生效；其他页面暂不消费该变量，行为不变。
- `apps/web/index.html` viewport meta 追加 `interactive-widget=resizes-content`：Android Chrome 布局视口随键盘收缩获得同等效果；iOS 忽略该属性，无副作用。

## 消费与行为

- `apps/web/src/styles/globals.css` 的 `h-today-viewport` 高度公式追加 `- var(--kb-inset, 0px)`：键盘弹起时卡身压缩，dock（选项/输入框/主操作）贴键盘上沿，fixed 顶栏不动，题干反馈区 `min-h-0 overflow-y-auto` 吸收高度变化。
- Today 激活会话期间，`useKeyboardInset()` 数值 > 0 时锁 `document.body` 滚动（`overflow: hidden`），键盘收起或组件卸载时恢复，杜绝 iOS 聚焦输入框时把 document 顶起。锁仅作用于 Today 会话路由，其他页面不受影响。
- 纯 web 改动：无数据库、无 API、无共享契约变化。

## 测试与验收

- 单元测试（jsdom mock `window.visualViewport`）：inset 计算与夹取取整、CSS 变量写入与清零、监听绑定与解绑、无 visualViewport 时 no-op。
- E2E 新用例：向 `<html>` 注入 `--kb-inset: 260px` 后断言几何——Today 卡底上移至键盘线以上、顶栏仍在视口顶部原位（CI 无法模拟软键盘，以变量注入钉死消费公式与布局行为）。
- 真机验收（用户 iPhone，Safari 与主屏 PWA）：填空/表达题聚焦输入框后顶栏可见、题干可滚、输入框与提交按钮在键盘上方；收起键盘布局恢复；页面不被顶起。
