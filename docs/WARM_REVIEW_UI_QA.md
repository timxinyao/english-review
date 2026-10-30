# 暖纸配色与复习卡片间距验证（2026-10-30）

本次按用户确认的设计恢复暖纸色卡，保留新版大字号和操作区，收小圆角，并为手机活动复习卡与底部 Tab 留 20px 间距。规格见 [设计](superpowers/specs/2026-10-30-warm-review-spacing-design.md)，实施见 [计划](superpowers/plans/2026-10-30-warm-review-spacing.md)。代码验收后，用户追加部署授权，已于 2026-10-30 16:21（Asia/Shanghai）将 `e0cf6c2` 的前端产物发布到生产；后端代码与运行目录一致，无需重启 API。

生产 HTTPS 与 HTTP 两入口的首页、所引用 CSS/JS、manifest 和 Service Worker 均与新构建逐字节一致，API 健康检查均为 `ok`；线上 CSS 包含暖纸色、12px 基础圆角和 20px 导航留白。旧静态资源已备份，本机发布记录及独立复核位于 `output/warm-review-spacing/deployment/`。没有登录生产账号作答，iPhone/PWA 客户端更新仍需真机确认。

## 变更与回归

- 17 项语义色与 `ac44644^` 的旧色卡一致。页面背景 `#f4f3ee`，卡面 `#fbfaf7`，强调 `#ae563d`；半透明 chrome、HTML theme-color 与 PWA manifest 同步。
- 基础圆角 12px，活动卡圆角 16px。保留现有词条字号、44px 最小触控与 48px 主动作。
- 顶栏与导航的高度基准计入实际内容、边框和安全区。活动卡可用高度扣减导航及 20px 留白；触摸保护和键盘预置分支共用同一基准，键盘可视边界分支保持原有停靠。
- 新增真实浏览器几何回归，修复前窄屏、普通手机及模拟安全区的卡/Tab 间距为 -1px，修复后均为 20px。原有紧凑学习 E2E 先等待芯片出现再读取数量，保留点选后芯片数量不变的断言；旧等待竞争在未修改产品文件的基线上连续复现 3 次，修正等待后连续通过 3 次。

## 独立浏览器验收

本会话未提供 Browser 插件，使用项目已有 Playwright 1.63.0 与 Chromium。API 使用临时 SQLite 和 mock provider，不连接生产数据。实际操作覆盖登录、开始复习、表达题反馈、Recall 揭示、长译文滚动和继续下一题。

| 视口 | 顶栏底 / 卡片顶 | 卡片底 / 导航顶 | 结果 |
| --- | --- | --- | --- |
| 320×480 | 63 / 149px | 391 / 411px | 表达、Recall、揭示态间距 20px，操作可触达 |
| 390×844 | 63 / 149px | 755 / 775px | 同上，无横向溢出 |
| 390×844，模拟顶部 24px / 底部 34px 安全区 | 87 / 173px | 741 / 761px | 安全区实际生效，间距仍为 20px |
| 1280×800 | 桌面无手机 chrome | 不适用 | 长内容页面滚动 43px 后按钮完整显示，点击进入下一题 |

长内容在手机卡片内部滚动，操作区仍可见。页面无空白、Vite 遮罩、console error 或 pageerror；存在 React Router future flag 和页面关闭时 AudioContext 警告，未据此验证音频播放。

截图与详细测量保留在本机 `output/warm-review-spacing/`（不进 Git），包含 `phone-recall.png`、`narrow-short-recall.png`、`safe-area-expression.png`、`desktop-scrolled.png`、`measurements.json`、`desktop-scroll.json` 和独立视觉报告。验收进程已按身份核对并停止。

## 自动门禁与测试维护

| 命令 | 最终结果 |
| --- | --- |
| `pnpm lint` | 通过 |
| `npm_config_workspace_concurrency=1 pnpm typecheck` | 通过 |
| `npm_config_workspace_concurrency=1 pnpm test` | 1,025 项通过（shared 15、API 677、web 333），0 跳过 |
| `E2E_API_PORT=25174 pnpm e2e` | 26 项通过，10 项既有跳过，退出 0 |
| `npm_config_workspace_concurrency=1 pnpm build` | 通过 |

单元测试与构建针对 `1b1ad56`；此后至 `bddf52f` 仅修改测试、文档与源码注释，无可执行产品逻辑变化。最终 lint、typecheck 与完整 E2E 针对 `bddf52f` 重跑通过。日志及独立验证报告保留在上述本机输出目录。

终审后在 `babdfcb` 将个人例句负向断言收严为数组长度为 0，并补全高度公式注释；对应历史 E2E 单独重跑 1 项通过，格式、ESLint 与 diff 检查通过，未修改可执行产品逻辑。

首次 typecheck 以 143 退出，没有类型诊断；同期 earlyoom 日志记录低内存及 Chrome/Node 进程被终止，但未保存 Node PID 对应关系，不能断言就是该次 tsc。降低工作区并发后完整类型检查通过。

完整门禁最初出现 7 个端到端失败，均在未修改的 `1cfb29c` 主干及独立临时数据库上复现。原因是既有测试仍期待旧进度文本、「下一题」和自由造句的 diff/自动个人例句，部分用例还依赖前一例创建历史或使用了不匹配的 mock 拼句。仅同步 `production.spec.ts` 与 `today.spec.ts` 到现行拼词契约，保留实际作答、分项结果、历史、只读记录、进度与首屏时限验证；未修改学习行为。两文件修正后 9 项通过，原有 10 项跳过保留。

## 证据限制

10 项跳过与基线一致，涉及 pending 重试、追加学习、撤销、关闭目标、旧式输入及键盘避让等路径，不将这些路径记为通过。

以上为浏览器模拟视口与 CDP 安全区，不代表 iPhone 真机验收。未验证真实软键盘、系统安全区、PWA 安装启动、其他浏览器、屏幕阅读器或真实音频。既有退役键盘输入 E2E 的跳过状态单独计入门禁结果；本次布局测试的 CSS 键盘分支不能替代原生键盘验证。

本报告补充 2026-10-29 的历史 [Native learning QA](NATIVE_LEARNING_QA.md)，恢复暖色及本轮可用浏览器 runner 的结论以本报告为准，历史验证数和环境限制不改写。
