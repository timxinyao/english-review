# Phase 9 — Foxi V2 学习流程

开始：2026-09-30。结束：2026-10-02。状态：done。目标：按已批准的 V2 设计将 Learn → Recall → 选择性 Production → Read 自然复现落地，保留历史并安全切换。

## 范围

- 三态造句目标、条件化 mastered、导入/Library/备份契约。
- 正式 Recall 与完整句子 Production、Library 非正式练习、Today 懒绑定与失败重试。
- Read 停止新检查与 reinforcement；旧会话和历史兼容；本地日边界的一次性迁移。

## 完成标准

- [x] Word/Chunk 默认及显式覆盖在后端、API、UI、导入/备份一致。（Task 1–3/8/10：goals 单测、Library 三态 UI+E2E、导入冲突预览/逐项确认、备份 1.2/2.0 双向）
- [x] U/P 正式任务、Library practice、Read 符合 V2 题型契约。（Task 5–9：P 一律 production、练习恰好 [recall] / [recall, production] 且零正式写入、Read 纯阅读 + 遗留只读；Task 10 全流程 E2E 复核）
- [x] 切换日、旧 Session、旧备份迁移正确且可重试。（Task 4/7 事务化 cutover 与跨日 409 套件；Task 10 在生产 pre-V2 库副本实测：63 项 P 全重置、14 项当日到期、U/状态不动、二次运行字节级 no-op；1.2 恢复独立重置、2.0 保留）
- [x] 大队列首屏不阻塞，生成失败任务可重试且不丢进度。（Task 6 单测 100 到期 + Task 10 E2E 44 到期 start 即返全量 pending、失败重试/稍后保留总量）
- [x] lint、typecheck、test、E2E 与涉及 Prompt 的 Eval 通过。（2026-10-02：lint 0 / typecheck 0 / API 534 + web 227 / e2e 27 / generate_read GLM 1/1，changed-digest 复核为非确定生成差异）

## 决策记录

| 日期 | 决策与理由 |
| --- | --- |
| 2026-09-30 | 依已批准设计用三态覆盖值；null 保留类型默认，避免旧 Word 被错误强制造句。 |
| 2026-09-30 | 退役新 cloze 与 Read checks：两者不再是 V2 目标能力证据；历史保留只读，避免破坏既有记录。 |
| 2026-09-30 | Task 1 仅建立文档、字段与 review 目标判定；Session、迁移语义、导入和 UI 在后续子任务实现。阶段不提前标 done。 |
| 2026-09-30 | Task 2 的 Library 目标开启把首次 P-L0 排到用户配置时区的下一本地日 00:00；既有 P 状态不改，当前 Session 不插题。关闭目标仅取消当日未答 P；复习排期写入仍归 review service。 |
| 2026-09-30 | Task 3 导入合并与 Library PATCH 共用造句目标协调逻辑，避免导入绕过当日待答 P 取消及 review service 的 mastered/排期规则；旧 1.2 备份缺字段恢复为 null，旧 P 清零由 Task 4 的一次性迁移处理。 |
| 2026-09-30 | Task 4 使用 `app_metadata.foxi_v2` 作为数据库级一次性标记；标记与旧 P 清零、Read reinforcement 清旗及状态重算同事务。1.2 备份按备份版本每次独立归一化，2.0 备份保留 P，不受标记影响。仅实现启动/预取入口的迁移调用，实际切换须在下一 APP_TIMEZONE 本地日边界发布。 |
| 2026-10-01 | Task 5 停止新 cloze 的直接获取与生成；历史 cloze 行、解析与评分代码保留。旧 Practice 调用在 Task 8 改造前暂不能取得 cloze，不为旧入口恢复新题能力。 |
| 2026-10-01 | Task 6 将 Today 创建/同日追加改为先保存全部 pending 任务，独立 prepare 在题目生成锁下取题、短事务内校验并绑定；失败保留可重试任务。旧 Read 标记不再制造新的 Today 补强，历史行保持可读；这是 V2 契约的收敛，不改 Read API。 |
| 2026-10-02 | Task 7 在作答评估前及结算事务内校验本地日，HTTP 作答额外传入结算时钟，防止 AI 等待跨午夜；later、坏题和反馈在任何回放/变更前校验。已退休题也在评估前/事务内拒绝。Learn 只为有效造句目标初始化 P。旧 cloze/Read 撤销回归改为显式历史已绑定夹具，不恢复 V2 新题能力；E2E 的 word「give up」显式开启 P，以保留表达及键盘流程测试。 |
| 2026-10-02 | Task 7 规则核对发现坏题撤销既有缺口：Production 尝试/通过统计未回减。依据“坏题撤销全部学习影响”补最小 delta，与普通 undo 保持一致；以通过/失败两例验证统计、Stage、attempt void 和幂等，不扩展产品范围。 |
| 2026-10-02 | Task 9 generate_read 升 v2 为纯阅读：Schema strict 拒绝含 `checks` 的模型输出（completeStructured 重试兜底），新文章 `checks_json='[]'`；`POST /api/read/:id/check` 绑定 `foxi_v2` 标记，cutover 后一律 409（旧/新文章相同、零写入），cutover 前遗留窗口保留判定与 read_check attempt 但不再置补强旗——Read 路径至此不再设置 `needs_reinforcement`。旧文章已答检查题经视图 `answered` 字段只读回放（未答不泄露 correctOptionId、无提交入口）。 |
| 2026-10-02 | Task 10 E2E 种子扩展走独立测试端点（`/api/__e2e/seed-v2-journeys`、`seed-large-queue`）而非并入基础种子：基础种子的到期数/任务总数/学习项计数被既有 spec 钉死（"今日到期 4 项"、"0 / 5"、总学习项 6），追加项按用例显式播种可保幂等与既有断言不动。make sense 的表达题库存进基础种子（chunk 默认开的练一下第 2 题，e2e 无 AI 不可懒生成）；fake 批改按 payload.mustUse 泛化，give up 既有判定不变。 |
| 2026-10-02 | Task 10 发布审计在生产库只读在线备份副本上执行（better-sqlite3 readonly backup，绝不写生产文件）：迁移 0001–0006 + applyV2Cutover 一次成功（63 项全部 P 行重置 L0、14 个 active+started+有效 P 项当日到期、needs_reinforcement 清零、U/paused/archived/历史不动、二次运行字节级 no-op）；2.0 备份导出/恢复保留 P、1.2 备份恢复独立重置 P（chunk 排期、word 默认关不排期）。跨日/stale-tab 409 与 cutover 语义以集成套件为凭（e2e 服务刻意不跑 cutover，Task 9 已披露）；generateRead changed-digest 经真实输出复核（无 checks、coverage 完整），属非确定生成差异而非回归。 |

## 变更日志

| 日期 | 变更 |
| --- | --- |
| 2026-09-30 | 开启 Phase 9；同步 V2 正式文档，落地 Task 1 基础目标模型。 |
| 2026-09-30 | Task 2：Library PATCH/UI 支持三态造句目标；当前 Session 待答 P 原子取消、进度/完成态重算，跨设备旧题提交 409；新增 API、组件和 E2E 覆盖。 |
| 2026-09-30 | Task 3：学习库与完整备份导出升至 2.0；导入/恢复接受 1.2 和 2.0，保留三态覆盖及 V2 P 状态；重复导入显式冲突预览、逐项确认、事务内并发重查，新增 API/组件/E2E 测试。 |
| 2026-09-30 | Task 4：新增 `0006` 元数据表与事务化 V2 cutover；全部旧 P 重置为 L0，已学且有效需 P 的 active 项当日到期，旧 U/历史/统计保留。旧 1.2 备份每次恢复时重置 P，2.0 保留；覆盖混合状态、幂等、迁移与恢复测试。未运行生产迁移、未部署。 |
| 2026-10-01 | Task 5：正式 U/P 题型分别固定为 understanding/production；到期预取按有效 P 目标过滤，不读 P Level、不补旧 cloze，New Queue 仍只备 understanding。增加旧 cloze 库存隔离、关闭 P、L0–L7 与真实 Today 绑定测试；过渡期旧 Today/Practice cloze 测试由后续任务更新。 |
| 2026-10-01 | Task 6：start/extend 快速建立含空 questionId 的完整任务队列；新增答案不可见的 prepare API、并发单题绑定与后台最多两题前瞻。补充 100 到期、失败重试、过期/取消/目标关闭/快照失效与 API 契约测试；旧答题单测夹具显式 prepare，旧 Read 新任务断言改为 V2。剩余旧填空/Read 撤销及 Practice 断言留后续任务。 |
| 2026-10-02 | Task 7：Today pending 卡自动 prepare，展示正在准备、失败重试/稍后/刷新；Recall 作答失败提供错误和刷新入口，选择题仍只经 Hint 进入。补充跨日零写入、目标初始化、失效题、加载/失败恢复测试，恢复 Recall + 有效 P 的多任务完成覆盖并保留 give-up/replay/答案隐藏及历史 Read undo。未修改键盘几何、Prompt 或生产数据库；阶段仍 in-progress，最终门禁及 Task 8 遗留项见 Task 7 报告。 |
| 2026-10-02 | Task 7 收尾：待答退休题刷新时隐藏旧题并重新 prepare，已完成历史仍保留；修复 Production 坏题撤销遗漏的统计回减，新增 Red→Green 回归。 |
| 2026-10-02 | Task 9：Read 变纯阅读——`generate_read.v2.md`（含“禁输出 checks”硬性契约）+ Schema strict + mock/E2E fake 同步；check 路由 cutover 后 409、遗留只读回放（`ReadCheckView.answered`）与 UI 无提交入口；`AI_RULES.md` §11 与 Prompt Registry 表更新。Eval：1 个固定案例（gr01-mixed-items），GLM（glm-5.3-flash）首试通过（307 词、coverage 全覆盖、无 checks 字段），旧基线因 fixture 与 v1 Prompt 变量漂移（缺 `focus_list/old_list`）早已不可复现，修正 fixture 输入为真实运行时变量后重存 v2 基线；生成式输出非确定，changed-cases 仅作复审触发器，机器门槛是 Schema/不变式零失败。取舍：遗留未答检查题保留展示（不隐藏历史）但无提交动作；补强旗从遗留判定路径一并移除，避免 V2 代码任何 Read 写路径复活已退役标记。 |
| 2026-10-02 | Task 10：全流程验收与阶段收口。e2e-server 新增 V2 journey/大队列种子与端点、make sense 表达库存、fake 批改按 mustUse 泛化；新增 E2E：Learn→次日 Production（chunk Learn 初始化 P、次日表达题可作答、显式关闭 chunk 被排除）、Library 关闭造句取消当日 P、大队列 44 到期 start 即返全量 pending、练一下选择性出题（word 默认关 1 题 / chunk 默认开 2 题）；pending/retry、纯 Read、窄屏/键盘避让复用既有 spec。门禁全绿（lint/typecheck 0、API 534 + web 227、e2e 27/27、format:check 0、git diff --check 0、generate_read GLM 1/1）；format:check 补齐 Task 5–9 遗留的 22 文件 prettier 噪音。生产 pre-V2 库副本迁移+cutover 审计 15 项全过（见决策记录）。阶段 done；未提交、未推送、未部署，发布须按计划在下一 Asia/Shanghai 日边界后整版部署（首次 V2 boot 自动跑迁移+cutover，已验证幂等）。 |

## 总结

- V2 契约全线落地：三态造句目标（word 默认关 / chunk 默认开 / override 优先）贯穿 Library、导入、备份与 Today 组卷；正式理解一律 Recall（选择仅 Hint）、正式造句为整句表达，新 cloze 与 Read checks 全面退役（历史只读保留）。
- Today 改为先建全量 pending 队列、prepare 懒绑定（生成锁下取题、短事务比较绑定），失败可重试/稍后且不丢任务；跨日作答/回放/撤销/反馈一律 409 零写入。
- 一次性 `foxi_v2` cutover 与 1.2 备份恢复归一化分离：标记只管库级切换，旧备份每次恢复独立重置 P；实测幂等（二次运行字节级 no-op）。
- 验收数据（2026-10-02）：lint 0 / typecheck 0 / 单测 API 534 + web 227（761）/ e2e 27/27 / generate_read GLM 1/1（changed-digest 复核无回归）；生产库副本（63 项、63 P 行、4 行 level>0、14 项有效 P）迁移+cutover 审计 15 项全过。

## 遗留问题（不阻塞发布）

1. **发布时序**：V2 为一次性整版切换，须在下一 `APP_TIMEZONE`（Asia/Shanghai）本地日边界之后部署；首次 V2 boot 自动执行迁移+cutover（幂等已验），切勿在边界前重启混布。切换日将出现 14 项 P 任务集中到期（旧 P 清零后的预期行为）。
2. **旧 P 证据作废**：旧 P level 混入 cloze 证据，一律清零重来（设计决策）；历史 attempt/例句/统计保留，用户可见学习进度（U 维度）不受影响。
3. **E2E 服务不跑 cutover**（Task 9 已披露）：跨日 409 与 cutover 语义由集成/单测覆盖（today.test.ts 旧日全 409、v2-cutover.test.ts、migrate-smoke 等 41 项抽验通过）。
4. Task 8 终审 triage 留档项：真实 AI 题的 recall Hint 选项文本可能≈释义（字段级防泄漏或 fetch-on-hint 待产品决策）；`practice.test.ts` 一处 `not.toContain('cloze')` 死断言；recall 与 selectedOptionId 并发送达时 recall 静默胜出（可改 400）；`insertAttempt` 单插包事务（既有）。
5. Task 9 留档项：`read/service.ts` cutover 前幂等回放历史 Read check 可能回 `needsReinforcementMarked:true`（历史回放语义，注释已载）；archive 文档仍含 V1 描述（历史文档，不改）。
6. iOS 真机键盘（Phase keyboard-inset 遗留，与本阶段无关但同批部署）：调试浮层仍在，待用户真机复验后移除。
