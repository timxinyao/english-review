---
name: library-english
description: Use when the user wants to query or manage existing data in the English Review learning library — 查进度/统计（"xx 学得怎么样/什么进度/还剩多少/学习统计"），修改内容（"改释义/改例句/加例句/改备注"），或生命周期操作（"把 xx 删了/归档/暂停/恢复/重置/标记掌握"、"导出备份"）。
---

# library-english：对话式管理学习库

操作已有学习数据，全部通过 `el-cli` 走正式 API（与 Web 界面同一契约）。**核心纪律：先查、告知后果、用户确认、再执行。**

## 通用命令

```bash
cd /var/www/english-review/apps/api && pnpm exec tsx scripts/el-cli.ts <命令>
# find [关键词] [--type word|chunk] [--status active|mastered|paused|archived]
# show <id>          # 例句/两维进度/造句历史
# set <id> --json '<局部 JSON>'
# archive|restore|pause|resume|reset|master <id>
# stats              # 学习统计
# backup <out.json>  # 完整备份
```

密码/地址：CLI 读 `/etc/english-learning/env` 的 `AUTH_PASSWORD`——该文件 root-only，普通用户读不到时用 `IMPORT_PASSWORD=<密码>` 注入（`sudo cat /etc/english-learning/env` 查看）；地址用 `IMPORT_API_BASE` 覆盖。

## 工作流（每个操作都走这套）

### 1. 查询类（只读，直接做）

"wear down 学到哪了？" → `find wear down` 找到 id → `show <id>` → 用自然语言转述（阶段、下次复习时间、例句、造句历史）。"还剩多少没学/统计" → `stats`。

### 2. 修改类（必须确认）

先 `show` 拿当前值 → **告知操作后果**（见下表）→ 等用户确认 → 执行 → 回报结果。

| 用户说 | 执行 | 必须告知的后果 |
|---|---|---|
| "删了/不要了" | `archive` | 是**归档**不是物理删除，可恢复；Library 默认隐藏该词 |
| "改释义/改例句/加例句/改备注" | `set --json '{"meaning":"…"}'` | 改 **target/meaning** 会让该词全部未用题目作废（重新生成）；释义变化系统可能建议重置进度（响应有提示时转告用户，用户要重置才执行 `reset`） |
| "重置进度" | `reset` | 清空两维进度，回到 New Queue 按每日额度重新学 |
| "暂停/恢复" | `pause` / `resume` | 暂停后不再进 Today，进度保留 |
| "标记已掌握" | `master` | 两维直接置稳定，退出正式复习 |
| "导出备份" | `backup /tmp/english-review-backup.json` | 告知文件位置，提醒自行保存到电脑 |

### 3. 编辑的 JSON 字段（set --json）

`target` `meaning` `ipa` `source` `sourceUrl` `tags`（数组）`notes` `sourceExample` `extraExamples`（字符串数组，全量替换）`personalExamples`（`[{"id":"…","pinned":true}]` 局部更新）。例：

```bash
pnpm exec tsx scripts/el-cli.ts set <id> --json '{"meaning":"新的释义","notes":"新备注"}'
```

## 原则

- **"删除"永远执行归档**（产品无物理删除），并明确告知可恢复。
- 破坏性/影响进度的操作（archive/reset/set 改 target 或 meaning）必须先展示当前值并得到用户明确同意；用户原话就是指令时可视为已同意（如"把 raw 删了"→ 展示 raw 当前状态 → 执行 archive → 回报）。
- 一次只动用户点名的词条；批量操作先列清单再逐项确认。
- `find` 输出的 `id=…` 是完整 id，直接用于 `show`/`set`/各操作命令。
