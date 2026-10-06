# English Learning Tool V2 — Technical Design

> 架构、技术栈、模块/API/部署基线

**Version 2 · 2026-09-30**

## V2 实施契约（替代下文 V1.2 填空与 Read 检查流程）

Review service 集中计算 `effectiveProductionEnabled = override ?? (type === 'chunk')` 与条件化 mastered，只有该 service 能推进 U/P Stage、排期和 mastered。Learning Item 保存可空三态覆盖列，API 列表和详情同时返回显式覆盖值及有效值。Library 改目标时事务化重算状态，paused/archived 不自动激活；关闭 P 取消当前未答 P 任务，开启 P 从下一次 Today 加入。导入、导出、备份/恢复必须保留显式值，旧备份按 null；重复导入显式冲突需预览确认。

V2 正式 U 只出 Recall（四选一仅 Hint），正式 P 只出 target 可见的完整造句，不再生成、预取或分配 cloze。新项 P 首次不早于 Learn 后下一本地日；旧 P 在本地日切换的一次性事务迁移中重置 L0，已 Learn、active 且需 P 的项切换日到期。旧 U、历史及统计保留。旧 Session 跨切换日后写操作拒绝；Read 不再生成检查或 reinforcement，旧记录只读并清理旧标记。旧 cloze/Read 检查实现与 Prompt 仅服务切换前 Session 和历史，后续阶段移除时需同步 Schema/Prompt Eval。

Today Session 先返回所有到期任务；理解题卡即时渲染不依赖绑定题，造句题在会话创建/追加响应后由后台一次性备好（逐题 best-effort，失败留可重试 pending 任务），AI 调用必须在 SQLite 写事务之外。生成失败只留可重试 pending 任务，绑定须并发保护。Library practice 为一道 Recall 加可选一道完整造句，不改变正式进度。Phase 9 按子任务逐步实现；本文件的 V2 规则描述目标架构，不代表尚未实施的路由已上线。

# 1. 文档目的与实现原则

本文档定义英语学习工具 V1.2 的工程实现基线。产品行为以 PRODUCT_DESIGN.md 为准；本文只回答“如何实现这些业务真相”。如果技术实现与产品规则冲突，优先修改实现，而不是擅自改变产品行为。

## 1.1 技术原则

- 单机优先：单用户项目不为理论扩展性引入分布式系统。
- 少依赖：能用现有技术完成的能力，不额外引入 Redis、消息队列、Agent、RAG、向量数据库等。
- 强类型与共享 Schema：前后端共享 TypeScript 类型与 Zod Schema。
- 后端掌握业务状态：Stage、Session、Question lifecycle、New Queue 等逻辑不得放到前端自行计算。
- 事务优先：一次答题引起的 attempt、review state、reinforcement task 等变化必须原子提交。
- AI 可替换：业务层只依赖 AI service interface，不依赖某个模型厂商的响应格式。
- 可恢复：SQLite 与完整备份必须能在单机故障后恢复。

# 2. 总体架构

```text
Internet
   │
 HTTPS
   │
 Nginx
   ├──────────────→ React + Vite PWA (static)
   │
   └──────────────→ Fastify API (Node.js / TypeScript)
                         │
                 ┌───────┼──────────┐
                 │       │          │
              SQLite   AI API    systemd timers
                 │                  │
                 └──── backup ─────→ S3
```

V1.2 使用单台 AWS EC2 Linux 主机。Nginx 负责 HTTPS 终止、静态资源与 /api 反向代理；Fastify 进程由 systemd 管理；SQLite 文件位于本机持久磁盘；定时任务由 systemd timer（或 cron）触发；备份写入 S3。

> 移除原方案中的 EventBridge。对于单用户、单机 SQLite 项目，EventBridge 会增加调用链和部署复杂度，但不带来实质收益。

## 2.1 不做的基础设施

- 不使用 Kubernetes。
- 不使用 Redis。
- 不使用消息队列。
- 不使用 PostgreSQL（V1.2）。
- 不使用独立向量数据库。
- 不使用服务拆分或微服务。
- 不使用前端离线业务数据库。

# 3. 技术栈基线

| 层 | 技术 | 约束 |
| --- | --- | --- |
| Package manager | pnpm | Monorepo 唯一包管理器。 |
| Frontend | React + TypeScript + Vite | 不切换 Next.js。 |
| UI | Tailwind CSS + shadcn/ui | 保持极简，组件源码可控。 |
| Routing | React Router | 不额外引入全栈路由框架。 |
| Server state | TanStack Query | 请求缓存、刷新、错误状态。 |
| PWA | vite-plugin-pwa | 只缓存静态资源，不缓存业务数据为真源。 |
| Backend | Node.js + TypeScript + Fastify | 不切换 NestJS。 |
| Validation | Zod | API、Import、AI output 共用 Schema。 |
| ORM | Drizzle ORM | 不切换 Prisma。 |
| Database | SQLite | 开启 WAL；单用户场景。 |
| TTS | Browser SpeechSynthesis | 前端调用。 |
| Web server | Nginx | HTTPS、静态文件、反向代理。 |
| Process manager | systemd | 管理 API 与定时任务。 |
| Backup | AWS S3 | SQLite 快照与长期备份。 |

具体依赖版本由 package.json 与 pnpm-lock.yaml 固定；本文档规定技术选择，不固定 patch version。

# 4. Monorepo 与项目目录

```text
english-learning/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   ├── pages/
│   │   │   ├── features/
│   │   │   │   ├── today/
│   │   │   │   ├── library/
│   │   │   │   ├── read/
│   │   │   │   ├── stats/
│   │   │   │   └── settings/
│   │   │   ├── components/
│   │   │   └── lib/
│   │   └── ...
│   └── api/
│       ├── src/
│       │   ├── modules/
│       │   │   ├── auth/
│       │   │   ├── today/
│       │   │   ├── learning-items/
│       │   │   ├── review/
│       │   │   ├── questions/
│       │   │   ├── read/
│       │   │   ├── import-export/
│       │   │   ├── stats/
│       │   │   └── settings/
│       │   ├── ai/
│       │   │   ├── promptRegistry.ts
│       │   │   ├── taskConfig.ts
│       │   │   ├── schemas/
│       │   │   ├── tasks/
│       │   │   └── provider/
│       │   ├── db/
│       │   ├── jobs/
│       │   └── lib/
│       ├── prompts/
│       │   ├── generate_understanding.v1.md
│       │   ├── generate_cloze.v1.md
│       │   ├── check_cloze.v1.md
│       │   ├── generate_production_prompt.v1.md
│       │   ├── check_production.v2.md
│       │   ├── generate_read.v2.md
│       │   └── judge_duplicate_meaning.v1.md
│       └── tests/
│           └── ai/eval/
│               └── fixtures/
├── packages/
│   └── shared/
│       ├── schemas/
│       ├── types/
│       └── constants/
├── docs/
│   ├── PRODUCT_DESIGN.md
│   ├── TECHNICAL_DESIGN.md
│   ├── DATABASE.md
│   ├── AI_RULES.md
│   ├── ARCHITECTURE.md
│   ├── DEVELOPMENT.md
│   ├── PHASES.md
│   └── phases/
├── AGENTS.md
├── README.md
├── package.json
└── pnpm-workspace.yaml
```

## 4.1 目录原则

- 前端按 feature 组织，Today 相关 UI、hook、query key、组件尽量放在同一 feature 下。
- 后端按业务 module 组织，不建立全项目级 controllers/services/repositories 横向大目录。
- 共享 Zod Schema 放 packages/shared；前后端不得复制维护相同字段定义。
- `apps/api/prompts/` 保存真正发送给模型的 Prompt Markdown 文件；Prompt 正文不得散落在 TypeScript 业务代码或数据库中。
- `ai/` 负责 Prompt Registry、模型调用、Schema 解析与错误归一化，不负责推进 Stage。
- `promptRegistry.ts` 统一加载 Prompt、校验 frontmatter、渲染变量并计算 SHA-256 `prompt_hash`。业务 task 不直接读文件。
- `tests/ai/eval/fixtures/` 保存固定 Eval Case；Prompt 调整应先跑 Eval，再发布。
- jobs/ 只调用业务 service，不直接写 SQL。
- db/ 包含 Drizzle schema、migration、transaction helper。

# 5. 后端模块职责

| 模块 | 职责 |
| --- | --- |
| auth | 固定密码登录、Session Cookie、登出。 |
| learning-items | Learning Item CRUD、状态切换、例句、New Queue。 |
| review | Understanding / Production 状态机、间隔、mastered 判定。 |
| today | 创建/恢复 Today Session、组题、later、补强任务、完成摘要。 |
| questions | 题库库存、生命周期、坏题、shuffle 所需 payload。 |
| read | 选词、生成 Read、检查题、needs_reinforcement。 |
| import-export | Import preview/commit、重复判断、library export、backup/restore。 |
| stats | 聚合统计与热力图。 |
| settings | 每日新项额度、content_level 等少量设置。 |

# 6. API 设计基线

## 6.1 基本约定

- 所有接口前缀 /api。
- JSON 使用 snake_case 或 camelCase 必须全项目统一；建议 API 与 TypeScript 均使用 camelCase，数据库列可使用 snake_case。
- 所有 request/response 使用 Zod Schema 校验。
- 业务错误返回稳定 error code，不把底层 SQL、模型异常或堆栈暴露给前端。
- 日期时间统一 ISO 8601；数据库存 UTC，展示按客户端本地时区。
- 修改型接口在服务端事务中完成。

## 6.2 建议 API

```text
POST /api/auth/login
POST /api/auth/logout

GET  /api/today
GET  /api/today/tasks
POST /api/today/start
POST /api/today/tasks/:id/answer
POST /api/today/tasks/:id/undo
POST /api/today/tasks/:id/later
POST /api/today/tasks/:id/bad-question
POST /api/today/tasks/:id/feedback

GET  /api/library
GET  /api/library/:id
PATCH /api/library/:id
POST /api/library/:id/pause
POST /api/library/:id/resume
POST /api/library/:id/archive
POST /api/library/:id/restore
POST /api/library/:id/reset
POST /api/library/:id/practice
POST /api/library/:id/practice/:questionId/answer
POST /api/library/:id/master

POST /api/import/preview
POST /api/import/commit
GET  /api/export/library
GET  /api/export/backup
POST /api/restore/preview
POST /api/restore/commit

POST /api/read/generate
GET  /api/read/history
GET  /api/read/:id
POST /api/read/:id/favorite
POST /api/read/:id/check

GET  /api/stats
GET  /api/settings
PATCH /api/settings

GET  /api/ai/models
GET  /api/health
```

补充说明（工程补齐，2026-09-24）：

- `POST /api/library/:id/practice/:questionId/answer`：Library“练一下”的作答端点。
- `POST /api/library/:id/master`：PRODUCT_DESIGN 5.2 的“标记已掌握”显式操作。
- `GET /api/health`：未认证存活检查，供部署 smoke test 与 Playwright webServer 探活。
- `POST /api/today/tasks/:id/feedback`：保留已有答题后反馈契约；新版 Today 不再展示“其实蒙的”二次操作，“太简单”仅在适用的正确作答后提供。
- `POST /api/today/tasks/:id/undo`：只接受当天 Session 最近一次未撤销的正式作答；恢复 attempt 的 pre-state、回减统计、取消其补强，并将同学习项重答任务置于待答队首；仅造句换题，其余复用原题。GET `/api/today/tasks` 返回可撤销 taskId 供前端显示图标；服务端仍必须再次校验以防多设备竞态。
- `GET /api/ai/models`：只读展示当前各用途（生成/判定）解析到的模型、来源（auto/config/fallback）、任务映射与可用模型清单（2026-09-25 新增，配套 §10.5 自动发现；不暴露 endpoint 与密钥）。
- Personal example 的 pin/unpin 并入 `PATCH /api/library/:id`，不单开端点。

API 名称是工程基线，可在不改变资源边界的前提下微调；禁止把 AI provider 的 endpoint 或 prompt 细节直接暴露给前端。

## 6.3 answer 幂等

同一个 review task 只能结算一次。answer 接口必须先检查 task.completed_at；已完成任务再次提交时返回原结果或稳定的 already_completed 响应，不得重复写 attempt、重复推进 Stage、重复生成补强任务。

多设备场景下，answer 的 task 状态检查与所有后续写入必须位于同一个 SQLite transaction。

# 7. Today Session 与队列实现

## 7.1 Session 创建

每个自然日最多一个正式 Today Session。首次打开 Today 时只返回 due 数量与 New Queue 可引入数量；点击 Start 后创建 session，并固定当时的基础任务队列。

Session 创建时从 New Queue 最多取 settings.maxNewItemsPerDay 个新项；如果当天已经开始过新 Item，则只补足剩余额度。

## 7.2 动态补强

理解题或填空题 fail 后可插入 reinforcement task。同一 Learning Item 在一个 Session 内最多新增 2 个 reinforcement task。插入位置必须位于当前任务之后若干题或队列后 30% 区域。

## 7.3 later

later 不写 attempt，不改变 review state。仅增加 task.defer_count 并将排序位置移动到 session 后部；Session 完成条件要求所有非 canceled task 均 completed。

## 7.4 坏题撤销

bad-question 必须在事务中执行：将 question 标记 bad_question；如果本次 attempt 已结算，则撤销对应 review state 变化和由该 attempt 新增的 reinforcement task。新版 Today 在「今日学习」的具体答题记录中提供坏题入口；服务端保存 attempt 前后 review state snapshot 或 event delta。具体字段见 DATABASE.md。

## 7.5 主动不会与最近作答撤销

`answer` 请求允许 `giveUp: true`，与选项、文本、自评互斥。Today service 不调用语言判定或批改，直接按 fail 结算并从已绑定题目的 payload 生成反馈：选择题正确选项和 explanation、填空完整句/可接受答案/explanation、表达题 referenceAnswer/acceptanceNotes。生产题 referenceAnswer 仅在作答后返回，未作答视图仍不泄漏。

普通撤销不调用 bad-question 路由，不更改题目状态。仅 production 在事务外获取/必要生成同学习项不同 id 的造句题；其余题型复用原 question_id（包括 Recall/Learn 的 null），不调用取题或生成。事务内按 attempt 实际插入顺序校验 task 仍是最近一次作答，回滚快照和全部计数、void attempt、取消旧任务及其补强、插入新的同学习项重答任务，并清除 Session completed_at。重答 sort_key 取剩余未完成/未取消任务的最小值减 1，没有待答任务则沿用旧 sort_key，保证 GET /api/today 立即返回该学习项；新 task id 避免重用旧任务破坏只结算一次及撤销历史。前端按新任务实例重置草稿、评分和揭示状态；撤销确认文案区分造句换题与其他题型复用。仅造句无法取得新题时不改变原作答。若造句沉淀替换了既有未固定个人例句或裁剪了表达历史，普通撤销需一并恢复；若新例句随后被固定或编辑，则拒绝普通撤销，避免丢失用户修改。重答任务沿用原 origin：撤销补强题释放原配额槽位，再由重答任务占用同一槽位；不会额外消耗 reinforcement 配额。Read 补强题沿用清旗语义（2026-10-04 修订）。

## 7.6 Today 输入键盘（2026-09-29 真机修正）

iOS 键盘状态不得以 `innerHeight - visualViewport.height - visualViewport.offsetTop > 0` 单独判定：布局视口缩小、视觉视口平移时该差值可为 0，而键盘仍打开。Today 聚焦输入框期间依据无键盘的可视高度基线与 `visualViewport.height` 判定键盘。活动会话从进入时就固定页面壳，不在聚焦瞬间切换 `position`；页面壳高度始终采用无键盘基线，顶栏和题面不读取视觉视口 offset 进行平移。卡片高度取「基线减顶栏/导航」与「当前可视高度减顶栏」的较小值；触屏预定位期间再与键盘安全高度取较小值。键盘上沿碰到卡底后底部 dock 上移，不以键盘已打开阈值切换高度，也不同时扣 `100dvh` 与 inset。底部导航从聚焦起隐藏。滚动锁从聚焦开始，到键盘真正收起才结束，不依赖 inset 值；避免反复 `scrollTo(0,0)` 与浏览器的聚焦滚动互相争抢。其他页面维持原布局。

2026-09-29 主屏 PWA 录屏复核：整页 `translateY(visualViewport.offsetTop)` 补偿仍会在 WebKit 异步更新 offset 时使顶栏/题面先上移再回弹，收键盘时闪白。废弃整页位移；顶栏、进度和题卡顶部保持固定。填空 Today 不自动聚焦，避免切题时未经用户操作弹键盘。曾在 `pointerdown` 同时移动真实输入框、`preventDefault` 并手动 `focus()`，导致同一次触摸的 click 命中输入框原位置下方页面、键盘立即收起；问题关键是 click 前移动命中区域。触摸点击完成后再预定位底部答题 dock；键盘动画期间仅 dock 跟随可视高度，题干区独立滚动。失焦且键盘实际收起后才恢复 dock 与底部导航。桌面 E2E 需覆盖完整触摸而非只派发 pointerdown。

2026-09-29 真机视口读数进一步确认：键盘稳定时 `visualViewport.height=389`、`offsetTop=107`，同时 `scrollY=html.scrollTop=107`，顶栏矩形恰为 `-107..-52`、题卡为 `-41..282`。WebKit 已经滚动 document，但 fixed 页面壳并未停留在可视顶部；卡高本身恰为预置 390px。尝试在输入/键盘阶段以 `scrollY` 逐帧校正页面壳与独立 fixed 顶栏，静态位置可对齐，但真机出现抖动，故废弃这条后验补偿。最终改为触摸 `pointerdown` 时在真实输入仍位于原处的前提下执行 `focus({preventScroll:true})`；不取消默认触摸、不移动输入。到合成 click 命中真实输入之前，卡高锁在无键盘基线，避免异步视口缩小抢先挪走命中区域；click 后再释放锁并预定位 dock。若触摸取消/未产出 click，短时超时清锁。目标是在源头避免 WebKit 的原生 107px 滚动，而非追帧补偿。用户已在 iPhone「添加到主屏幕」应用中确认此版键盘交互可用。

键盘交互回归门禁：组件测试覆盖原位聚焦、锁定与释放；移动端 E2E 必须覆盖完整 `pointerdown → pointerup → click`，并模拟视口在 click 前缩小，断言 click 仍命中输入框且焦点保留。浏览器模拟只能检查事件命中和最终几何，不能证明 iOS 主屏 PWA 的原生滚动与动画平顺。调整 `focus` 时机、输入框命中区域、页面壳定位、`visualViewport` 或 dock 算法后，发布验收还须在已添加到主屏幕的 iPhone 上检查：首次聚焦、输入、收起、再次聚焦，以及填空和表达两种输入；全过程顶栏/题面不跳动、键盘不自行消失、输入框停在键盘上方。遇到「静态位置正确但动画抖动」时，先记录 `innerHeight`、`visualViewport.height/offsetTop`、`scrollY` 与顶栏/卡片/input 矩形，确认是否发生 document 原生滚动，不再直接增加整页逐帧位移补偿。

2026-10-04 输入法下箭头收起修正：输入法可恢复视觉视口而不触发输入框失焦；此时旧 `anchored=editing||open` 永久保留 dock 的预置 48% 高度与隐藏导航。键盘开启仍以高度缩小超过 100px 判定，但开启后持续保持 open 到高度恢复至基线（允许 1px 舍入差），避免收起末段提前解锁。仅当已开启的键盘恢复全高且 Today 活动卡内的答题输入仍聚焦时，解除该输入的焦点并重测，清除预置高度、恢复导航与滚动；不清空草稿，不影响其他页面的输入焦点。普通 blur 收起沿用原有路径。单测与完整触摸 E2E 必须覆盖「不先 blur、只恢复视口」以及再次输入。iOS 表单辅助栏无网页端隐藏接口，保留系统栏。

2026-10-04 紧凑造句输入态：用户批准在完整触摸结束后将造句进度合并顶栏，收紧卡片和 dock，替代此前造句「题面位置完全不变」的约束以保证题干可读；pointerdown→click 期间仍禁止移动输入，动画期间不平移页面壳。公共 AutoGrowTextarea 复用 Textarea，使用同字体/内边距的隐藏 CSS 镜像排版，兼容不支持 field-sizing 的 iOS，无 feature 内联样式或逐字 DOM 高度测量。一行起步、最多四行，按可视高度提前封顶；中文题干独立滚动，target 不在滚动区内。真实键盘高度已知后不再使用预置 48% 上限，避免浪费可视空间；收起、草稿与焦点逻辑沿用上段修复。

2026-10-04 再次弹起维护：用户实机报告仅输入法自带按钮收起后再次打开出现整页上移与卡底空隙。原收起逻辑只释放焦点，未清理 document reveal 滚动；原触摸逻辑遇到已有焦点直接退出，未区分键盘已关闭和已打开。输入法恢复全高并释放 Today 焦点后，在下一绘制帧且仍失焦/idle 时清理根滚动一次；下一次同输入触摸前再检查迟到的遗留滚动。仅作用于该输入法收起路径，普通页面滚动不处理，不读取 offsetTop 平移整页、不逐帧 scrollTo。键盘已关闭时即使已有焦点也执行触摸命中锁与 click 预定位；已打开键盘中的重复触摸保持原行为。卸载取消待执行清理；重新聚焦时避免待执行清理干扰新键盘动画。模拟回归覆盖迟到的根滚动、系统预恢复焦点和重复完整触摸；原生动画仍需主屏 PWA 实机复验。

## 7.7 造句批改通知（前台提示音 + Web Push，2026-10-05）

前台提示音：`apps/web/src/lib/sound.ts` 用 Web Audio 合成（OscillatorNode+GainNode，无素材文件）——done=E5→A5 上行两连音（各 90ms、间隔 60ms）、fail=A3 单低音（约 140ms），总增益约 0.12、音头尾 10ms 淡入淡出。AudioContext 惰性单例，首次调用 suspended 即 resume（iOS 手势链——调用点在提交/结果交互后）；200ms 防抖兜 React StrictMode 双执行。表达题卡以 useEffect 监听 result/error 到达各响一次：判定 fail 或批改失败响 fail，其余响 done；主动不会（无批改）与取消（abort，不产生 error/result）不响。

Web Push（后台批改完成通知）：

- 订阅链路：设置页开关「批改完成通知」——GET `/api/push/vapid-public-key`（返回 null = 服务器未配置，提示并保持关）→ `Notification.requestPermission()`（granted 才继续）→ `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})` → POST `/api/push/subscribe`（endpoint upsert，开关状态持久化于服务器订阅表）；关闭走 POST `/api/push/unsubscribe` + 浏览器侧 `subscription.unsubscribe()`。GET `/api/push/status`（=订阅表是否有行）供刷新后初始化开关。iOS 仅「添加到主屏 PWA + HTTPS」下可用，失败给出可读提示。
- 发送钩子：today answer 路由在 production 作答**结算成功后** `setImmediate` best-effort 调 `sendGradingPush`：遍历订阅 `webpush.sendNotification(sub, {title:'造句批改完成', body:'${target} · ${verdictLabel}', url:'/today'}, {TTL:300})`。**恒发**——iOS 后台冻结页面时 fetch 连接未断、服务端无从得知客户端已不等结果，因此不依赖断连检测；幂等回放（alreadyCompleted）不重复发；VAPID 未配置（env 缺省）直接 return。
- 前台静默：SW（`apps/web/src/sw.ts`，vite-plugin-pwa `injectManifest`，precache 用 `precacheAndRoute(self.__WB_MANIFEST)`、不注册导航回退即不拦截 /api；skipWaiting+clients.claim 保留 autoUpdate 语义）在 push 事件中 `clients.matchAll({type:'window'})`，存在 visible 窗口（用户正看结果卡）即跳过 showNotification；`notificationclick` 已有窗口 focus + postMessage，否则 `clients.openWindow(data.url ?? '/today')`。
- 失效与可观测：推送服务返回 404/410（浏览器清数据/卸载）即删除订阅行；其余错误仅 `console.warn`（journal 可见，含 statusCode 与上游 body reason——Apple 会给如 `BadJwtToken`），不重试、不阻断作答响应。
- 订阅即自检+失败回滚：POST `/api/push/subscribe` upsert 后立即用新订阅发一条 `{title:'通知已开启', body:'批改完成时会在这里提醒你', url:'/today', test:true}` 自检推送（TTL 0）——`test:true` 使 SW 恒弹绕过前台静默（订阅瞬间用户必在前台，静默会吞掉弹窗；tag=`push-selftest` 不与批改通知互斥替换），用户点开可见即证链路通；自检失败回滚删除刚 upsert 的订阅（死订阅不残留），HTTP 仍 200 返回 `{ok:false, reason:'<statusCode> <body reason>'}`（如 `403 BadJwtToken`），前端开关回弹为关并展示 reason。
- VAPID 身份走环境变量 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`（/etc/english-learning/env，systemd EnvironmentFile 加载），任一缺省 = 功能休眠。

# 8. 复习状态机实现（2026-10-03 起 FSRS）

Understanding 与 Production 使用同一通用状态结构，不共享 FSRS 状态。业务代码只通过 review service 改变状态，其他模块不得直接 update。

核心为 ts-fsrs 引擎封装（`apps/api/src/modules/review/fsrs-engine.ts`）：`request_retention 0.90`、官方默认权重、`maximum_interval 365`、`enable_short_term=false`（分钟级学习步与产品天粒度排期不兼容）。单次演进读 review_states 行 → 还原 FSRS Card（`cardFromSnapshot`）→ `repeat(card, now, rating)` → 写回 D/S/reps/lapses 与 next/last；间隔 clamp 1..365 天；streaks 仅作展示照常更新。

| 结果 | 评分与状态变化 |
| --- | --- |
| pass（自评简单 / tooEasy） | Rating Easy；D/S 演进，间隔最长。 |
| pass | Rating Good；D/S 演进。 |
| basic_pass | Rating Hard（P 维度 AI 判分档；U 维度 assisted 仅历史数据）。 |
| fail | Rating Again；S 下降、间隔缩短，下限 1 天。 |
| guessed / gave_up | 按 fail（Again）。 |
| viewed_source | 结果上限 basic_pass（V1.2 历史规则；V2 Recall 卡无查看降档）。 |
| 所需维度 S 均 ≥ 120 | item → mastered（`reconcileItemStatus` 谓词，目标开关变化时重算）。 |

一次性切换（`fsrs-cutover.ts`）：`app_metadata` 写 `fsrs` 标记（幂等，二次运行字节级 no-op），事务内回放 `mode='today'` 且题目 kind 为 understanding/production 的 attempts（cloze/read_check/library_practice/void 跳过，按 created_at 时间序）重建 D/S，随后对全部 active/mastered 重算 status。boot 顺序：迁移 → Prompt Registry 校验 → v2 cutover → fsrs cutover → listen。旧备份恢复不含 attempts，改按 V1.2 level/stable 折算（`estimateFsrsFromLegacy`）。

Production 首次激活安排在 Learn 之后，初始 next_review_at = 次日（`PRODUCTION_FIRST_REVIEW_DELAY_DAYS=1`）。V2 起 P 正式任务均为完整表达题；V1.2 曾按 P-L1/L2 cloze、P-L3 混合、P-L4+ production prompt 分档（仅历史回放兼容）。

# 9. 题库与缓存

## 9.1 Question payload

Question 表保存题型、target meaning snapshot、context、options、correct option id、accepted answers、prompt_version、model、生命周期状态等。选择题 options 是无序集合；前端展示前随机 shuffle。

## 9.2 失效策略

- 修改 Learning Item.target 或 meaning：该 Item 所有 fresh/active generated questions → retired。
- 修改 source/extra example、notes、tags：不清题。
- Prompt 版本升级：旧题不强制回写；通过 prompt_version 可追溯。
- 用户 👎：question → bad_question，立即退出练习池。

## 9.3 库存补充

daily-prefetch job 扫描未来 48 小时可能到期的 Item/Dimension；低于目标库存时按批次调用 AI。请求失败不影响已有库存。即时需要且库存为 0 时才进行懒生成。

# 10. AI 集成与 Prompt 管理

## 10.1 AI Task 接口层

后端 `ai/` 目录提供 provider-neutral task，例如 `generateUnderstandingQuestions`、`generateClozeQuestions`、`checkCloze`、`generateProductionPrompt`、`checkProduction`、`generateRead`、`judgeDuplicateMeaning`。业务模块不得直接调用模型 HTTP API，也不得自行拼接 Prompt。

确定性业务规则与 AI 文本能力严格分开：

- Application 决定：选谁复习、什么时候复习、Stage 如何变化、数量限制、生命周期与状态。
- AI + Prompt 决定：题目文本、新上下文、自然语言纠错、受控表达题、Read 内容与重复义项建议。

## 10.2 Prompt Source of Truth

Prompt 正文使用独立 Markdown 文件，统一放在 `apps/api/prompts/`，并纳入 Git。**仓库中的 Prompt 文件是唯一事实源。**

V1.2 明确不做：

- 不把 Prompt 正文存数据库；
- 不建设 Prompt 管理后台；
- 不允许 task/service 中出现大段 inline prompt；
- 不允许同一 task 存在多个无人管理的 Prompt 副本。

数据库和业务实体只保存追溯元数据：

```text
prompt_key
prompt_version
prompt_hash
model
```

其中 `prompt_hash` 为 **Prompt 模板文件内容** 的 SHA-256（不是把每次动态输入渲染后再计算 hash）。这样同一个 Prompt 版本的不同调用保持同一 hash，也能发现版本号未更新但模板内容已变化的错误。

## 10.3 Prompt 文件格式

每个 Prompt 使用 Markdown + YAML frontmatter：

```markdown
---
key: check_production
version: 1
task: checkProduction
response_schema: CheckProductionResult
---

# Role
...

# Input
目标：{{target}}
...

# Output
只输出符合 Schema 的 JSON。
```

约束：

1. `key` 全局唯一且稳定；文件名变化不能改变业务 key。
2. 任何会真正发送给模型的 Prompt 正文变化，发布前必须 `version + 1`。
3. 变量使用受限模板语法；缺失变量直接报错，禁止静默渲染为空字符串。
4. 插入的 target、meaning、example、user answer 等都视为**数据**，Prompt 必须明确要求模型不要把这些字段中的内容当成新指令。
5. Prompt 文件中不保存 API Key、密码或部署环境信息。

## 10.4 Prompt Registry

应用启动时由 `promptRegistry.ts`：

1. 扫描/加载允许的 Prompt 文件；
2. 解析并校验 frontmatter；
3. 检查每个 `key` 只有一个当前生效的 Prompt 文件；
4. 计算模板 `prompt_hash`；
5. 编译严格变量列表；
6. 若文件名包含版本号，则校验它与 frontmatter `version` 一致；
7. 向 AI task 暴露 `getPrompt(key)` / `renderPrompt(key, variables)`。

Prompt 升级时直接将当前文件从 `.vN.md` 改为 `.vN+1.md` 并更新 frontmatter；旧版本由 Git 历史保留，不在运行时目录同时保留多个同 key 文件。

生产发布必须把 `apps/api/prompts/` 作为运行时资产一并复制到 release。若 Prompt 加载失败，API 应启动失败（fail fast），避免静默使用错误模板。

## 10.5 Model / Task 配置

模型别名与采样参数不塞进 Prompt 正文，也不存数据库，统一由 `taskConfig.ts` 按 task 管理并纳入 Git。Eval 结果必须同时记录实际 model。

Prompt 与 taskConfig 可以一起调整，但两者职责不同：Prompt 管语言行为，taskConfig 管模型与调用参数。

### 模型自动发现与覆盖（2026-09-25）

Coding Plan 的模型号会随版本演进（glm-5.3 → glm-5.4 …），因此别名解析规则为：

1. 环境变量 `GLM_MODEL_FLASH / GLM_MODEL_AIR / GLM_MODEL_MAX` **非空** → 使用指定值（source=config；不在可用清单时记 warning 但仍使用）。
2. 未指定（默认留空）→ 调用 `GET {GLM_API_BASE}/v1/models` 自动选择（source=auto）：
   - `flash`（题目生成）：版本最高的 `glm-*flash*` 型号（同版本取名字更短的 `-flash`）；
   - `air`/`max`（判定、批改、Read）：版本最高的**无后缀主模型**（`glm-X.Y`）。
3. 无 key 或发现失败 → 内置 fallback 常量（source=fallback），不阻塞启动。

解析结果进程内缓存（TTL 1 小时，失败 60 秒后重试）；版本比较按数字段（5.10 > 5.9 > 5.3）。前端在 Settings 只读展示（`GET /api/ai/models`）；endpoint 与密钥不暴露给前端。

任务级「模型×思考」策略以 [docs/MODEL_BENCHMARK.md](MODEL_BENCHMARK.md) 的基准数据为准（活文档：当前策略、历史矩阵、换模型对比指南与复现命令），变更策略须先跑基准并追加记录。

### 思考强度（2026-09-25）

GLM Anthropic 端点支持 `thinking: {type: 'enabled', budget_tokens}`（与 temperature 可同用；响应含 thinking 块，provider 只取 text 块）。档位与预算映射：`low=2048 / high=6144 / max=16384`。

- **任务级默认策略**（taskConfig）：判定/批改类（check_cloze、check_production、judge_duplicate_meaning）= low（质量优先，实测延迟可接受）；生成类 = off（速度优先）。
- **全局强制**：`GLM_THINKING=off|low|high|max` 覆盖任务策略；留空按策略。
- thinking 开启时 max_tokens 自动抬升为"预算 + 正文额度"，保证正文输出空间。
- Settings 的 AI 模型区块同时展示各用途当前思考档位；`GET /api/ai/models` 含 thinkingOverride 与逐任务 thinking。

## 10.6 Schema 校验与重试

- 模型输出先 JSON parse，再 Zod 校验，再执行语义检查。
- 结构化输出失败允许有限重试，建议最多 2 次。
- 重试仍失败时不写入脏数据。
- 表达题批改失败必须保留用户输入，并允许重新提交；不得推进复习阶段。
- AI provider key 仅保存在服务端环境变量。
- Prompt 要求 JSON 不能替代 Schema 校验；后端永远不信任模型输出。

## 10.7 Prompt 版本追溯

不同 AI 产物保存实际使用的 Prompt 信息：

- generated question：`prompt_key / prompt_version / prompt_hash / model`；
- Production 批改 attempt：同样保存批改 Prompt 元数据；
- Read article：保存 Read Prompt 元数据；
- AI 日志额外记录 task、耗时、成功/失败。

旧题不因 Prompt 升级而强制重生成；新生成内容使用最新注册版本。这样可以比较不同版本的坏题率、批改分布与人工反馈。

## 10.8 Prompt Eval Suite

Prompt 调整不能只靠“看一两个例子感觉不错”。仓库维护固定 Eval Case：

```text
apps/api/tests/ai/eval/
├── README.md
└── fixtures/
    ├── check_production.sample.json
    ├── generate_understanding.sample.json
    ├── generate_cloze.sample.json
    ├── check_cloze.sample.json
    ├── generate_read.sample.json
    └── judge_duplicate_meaning.sample.json
```

建议提供命令：

```bash
pnpm ai:eval -- --task check_production
pnpm ai:eval -- --task check_production --report /tmp/check-production-report.json
pnpm ai:eval -- --task generate_cloze
pnpm ai:eval -- --all
```

Eval 分两层：

1. **机器可判定约束**：Schema 合法、数量正确、focus target 覆盖、不得出现其他义项、Production 预期 pass/basic_pass/fail、字段长度等。
2. **人工/Agent 对比**：将新 Prompt 与上一版本在同一 fixtures 上的输出并排展示，只重点看发生变化的 case。`--report <path>` 保存逐 case 输入、期望、完整结构化输出与 Prompt/model 元数据，便于审阅改写、纠错和候选来源；不保存 Prompt 正文或环境变量。`check_production` 的 expected 支持嵌套字段，可锁定 score/kind/source 等机器可判定契约。

Prompt 修改标准流程：

```text
修改 Prompt
  ↓
运行对应 Eval fixtures
  ↓
查看旧版 / 新版差异
  ↓
修正回归问题
  ↓
prompt version +1
  ↓
提交 Prompt + Eval 结果摘要
```

修改 Prompt 的 Coding Agent 不得只说“效果更好”；必须说明测试了哪些 case、哪些结果发生变化、是否存在已知 trade-off。

## 10.9 Prompt Catalog

V1.2 固定 7 个 AI Prompt：

| key | 调用时机 | 实时 | 文件 |
| --- | --- | --- | --- |
| `generate_understanding` | 理解题补库存 | 否 | `generate_understanding.v1.md` |
| `generate_cloze` | 填空题补库存 | 否 | `generate_cloze.v1.md` |
| `check_cloze` | 填空答案本地规则无法判断时 | 按需实时 | `check_cloze.v1.md` |
| `generate_production_prompt` | 表达题补库存 | 否 | `generate_production_prompt.v1.md` |
| `check_production` | 用户提交表达题答案 | 是 | `check_production.v2.md` |
| `generate_read` | 用户生成 Read | 是 | `generate_read.v2.md` |
| `judge_duplicate_meaning` | Import 疑似重复时 | 按需 | `judge_duplicate_meaning.v1.md` |

Personal Example 的 `eligible / quality_score` 由 `check_production` 一并输出，不单独增加一次 AI 调用。

详细输入输出契约与 Prompt 行为规则见 `AI_RULES.md`；实际 Prompt 正文以 `apps/api/prompts/*.md` 为准。

# 11. Database 与事务

数据库使用 SQLite + Drizzle ORM。详细表结构见 DATABASE.md。V1.2 开启 foreign_keys 与 WAL 模式；所有涉及复习状态推进的写操作必须事务化。

- 启动时执行 PRAGMA foreign_keys = ON。
- 建议 journal_mode = WAL，降低读写互斥。
- 不从前端直接构造 SQL 条件。
- 所有 migration 纳入版本控制，不在生产库手工改表。
- 备份必须使用 SQLite 一致性快照方式，不直接复制正在写入的裸 db 文件。

# 12. 定时任务

| 任务 | 频率 | 职责 |
| --- | --- | --- |
| daily-prefetch | 每日 | 扫描未来 24～48 小时到期需求；补低库存题；标记可退休题目。 |
| weekly-cleanup | 每周 | 清理过期题目、Read、未收藏造句历史、bad_question、旧明细日志。 |
| monthly-maintenance | 每月 | 异常膨胀检查、深度去重、长期快照。 |
| daily-backup | 每日 | 创建一致性 SQLite 快照并上传 S3，保留 30 天。 |

任务由 systemd timer 调用 apps/api 提供的 job entrypoint。Job 必须可重复执行（idempotent），单次失败写日志并退出非 0；不需要引入任务队列。

# 13. 登录、安全与配置

## 13.1 登录

系统只有一个用户，不建设用户体系。使用固定访问密码，后端校验后设置 HttpOnly、Secure、SameSite=Lax Session Cookie，默认有效期 30 天。所有访问必须 HTTPS。

## 13.2 密码与密钥

- 访问密码只保存密码哈希，不明文落库。
- AI API Key、S3 凭证等通过环境变量或实例角色提供。
- 日志不得打印密码、Cookie、API Key、完整 AI 请求中的敏感配置。

## 13.3 CSRF 与来源

由于使用 Cookie Session，修改型接口应至少使用 SameSite=Lax + Origin/Referer 检查；若未来暴露跨站场景，再引入显式 CSRF token。

# 14. 备份与恢复

备份有两种模式，轮转策略一致（磁盘占用有界：日备 ≤30 份 + 月备 ≤12 份）：

| 模式 | 触发 | 保留 |
| --- | --- | --- |
| **S3 模式**（可选） | 设置 `S3_BUCKET` | 每日快照传 `s3://<bucket>/english-review/daily/`，30 天；月度 `monthly/`，12 个月 |
| **本地模式**（默认，无 S3 即用） | 未设置 `S3_BUCKET` | 快照落 DB 同级 `snapshots/daily-<yyyy-mm-dd>.db`（30 天）与 `monthly-<yyyy-mm>.db`（12 个月），自动轮转 |

S3 的意义是**异地容灾**（服务器整盘故障仍可恢复）。本地模式防软件级灾难（误恢复、数据损坏、误删）；异地容灾可另行通过 PC 手动导出完整备份 JSON（自带功能，存到自己电脑）或任何 S3 兼容存储补足。

快照不在本机堆积临时文件：备份 job 写本地临时快照（SQLite 一致性快照方式）→ 上传 S3 或转正为带日期的本地快照 → **立即删除临时文件**；S3 侧超期对象由备份脚本（aws-cli）或 S3 生命周期规则删除；本地模式按文件名日期轮转。数据库自身的增长由 §12 的清理 job 兜底。

Restore 使用完整备份 JSON 覆盖式恢复。提交恢复前必须先创建当前数据库快照；恢复过程必须在维护锁或事务边界内执行，避免同时答题。

# 15. 日志、错误与可观测性

- API 使用结构化日志，至少包含 request_id、route、status、duration_ms。
- AI 调用记录 task type、model、prompt_key、prompt_version、prompt_hash、耗时、成功/失败，不记录密钥。
- 定时任务写开始/结束、处理数量与失败摘要。
- 用户可见错误保持简短；底层错误仅写服务端日志。
- V1.2 不引入复杂 APM；systemd journal + 日志轮转足够。

# 16. 测试策略

## 16.1 必须单元测试

- review state machine：pass / basic_pass / fail / too_easy / guessed / viewed_source。
- mastered 判定。
- New Queue 每日额度。
- 单 Item 单 Session reinforcement 上限。
- bad-question 撤销。
- Import duplicate decision helper。
- question cache invalidation。

## 16.2 API 集成测试

- 重复提交同一 task 不得重复推进 Stage。
- 两个并发 answer 只允许一个成功结算。
- Restore preview/commit。
- Library practice 不修改正式 review state。
- Read check fail 只设置 reinforcement flag。

## 16.3 前端关键测试

- Today Session 恢复。
- 选择题选项 shuffle 仍能正确提交 option id。
- Correction diff 渲染。
- PC/手机响应式主流程。

## 16.4 E2E 与流程门禁

- E2E 使用 Playwright（`apps/web/e2e/`），覆盖每个阶段新增的用户可见主流程（登录、导入、Today 答题、表达批改、Read、恢复备份）。
- 每次开发遵循 docs/DEVELOPMENT.md 的 TDD 流程与 lint/typecheck/test 门禁。

# 17. 部署基线

```text
EC2 Linux
├── /opt/english-learning/app       # build / release
├── /var/lib/english-learning/      # SQLite / persistent data
├── /etc/english-learning/          # env / service config
└── /var/log/english-learning/      # optional file logs
```

1. CI 或本地构建 web 与 api。
2. 上传 release 到服务器并执行 pnpm install --prod / build 所需步骤。
3. 执行 Drizzle migration。
4. 重启 systemd api service。
5. Nginx 提供静态 web，并将 /api 代理到本机 Fastify。
6. 运行 smoke test：login → Today → Library → API health。

V1.2 不要求 Docker。若未来确有环境一致性痛点，可以单独评审是否容器化，但不得因此改变单机架构。

# 18. 技术 Definition of Done

- pnpm monorepo 可一条命令安装依赖并分别启动 web/api。
- 共享 Zod Schema 生效，无重复维护的 API DTO。
- 数据库 migration 可从空库创建完整 Schema。
- Today answer 事务与幂等通过测试。
- 定时任务可手工运行并通过 systemd timer 调度。
- S3 日备份和 Restore 演练成功。
- 所有 AI response 经 Schema 校验；失败不会污染数据库。
- Prompt Registry 可在启动时校验全部 Prompt，发布包包含 Prompt Markdown 资产。
- Prompt Eval fixtures 可重复运行，Prompt 修改有版本号与结果对比。
- Nginx + HTTPS + Session Cookie 可在 PC/手机 PWA 正常使用。
- 核心行为与 PRODUCT_DESIGN.md 一致。

# 附录 A：文档职责与优先级

| 文档 | 职责 | 冲突时 |
| --- | --- | --- |
| PRODUCT_DESIGN.md | 业务规则、页面行为、学习机制。 | 产品行为最高优先级。 |
| TECHNICAL_DESIGN.md | 架构、技术栈、模块/API/部署。 | 不得改变产品行为。 |
| DATABASE.md | 表、字段、索引、生命周期。 | 需满足前两份文档。 |
| AI_RULES.md | AI 输入输出、Prompt Registry、Eval 与模型约束。 | 不得自行改变复习算法。 |
| ARCHITECTURE.md | 前后端代码分层、目录、依赖方向、全局样式与组件约束。 | 不得与 TECHNICAL_DESIGN 冲突。 |
| DEVELOPMENT.md | 开发流程、TDD、测试流、lint 与提交门禁。 | 过程约束。 |
| PHASES.md | 阶段划分、进度与留档事实源。 | 进度以它为准。 |
| AGENTS.md | Coding Agent 工作规则。 | 开发时必须遵守。 |
