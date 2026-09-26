# 会话自动发音开关 — 设计（小型变更）

日期：2026-09-27

## 需求

Today 会话中切换到某单词（含新任务到达、列表回看、跳回当前）时自动播一次该词发音；提供开关可关闭。默认开启。

## 改动

- 存储：`localStorage['el:auto-pronounce']`，`'0'`=关，缺省/`'1'`=开（设备本地，沿用 TTS voice 按设备存 localStorage 的先例）。
- `ActiveSession`：`autoSpeak` 状态（惰性读 localStorage）；`useEffect` 依赖 `shownTask?.taskId` 与 `autoSpeak`——卡片到达/切换且开关开时 `void speak(shownTask.item.target)`；learn/回看/当前一致处理。
- 开关 UI：`ProgressRow` 右侧"列表 ▾"旁加图标按钮（lucide `Volume2`=开 / `VolumeX`=关），`aria-pressed` + `aria-label="自动发音"`，点击切换并写 localStorage。
- 互斥/解锁沿用现有 tts.ts（speak 自带全局互斥）。

## 测试

- 单测（新 `apps/web/tests/today-autospeak.test.ts`，mock `../src/lib/tts`）：默认开→当前卡自动 speak(target)；关→切换不 speak；localStorage 预置 '0'→挂载不 speak；开关按钮切换生效且 aria-pressed 反映。
- e2e 不加断言（speak 走真实 /api/tts 代理，UI 不阻塞）；跑既有 Today e2e 冒烟确认无破坏。

## 明确不做

- 不做 Settings 页入口（页内开关优先；后续需要再加）。
- 不自动读例句/句题干，只读单词 target。
