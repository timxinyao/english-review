---
name: import-english
description: Use when the user wants to add English words/chunks to the English Review learning library — triggers include "导入", "录入", "制卡", "记一下这些词", "加入学习库", "import 这些词"，或用户在对话中贴出词汇列表、生词笔记、JSON 词卡等一批想学的内容。
---

# import-english：对话式导入学习项

你负责两件事：**把用户零散的内容整理成标准导入 JSON**（这是你的语言能力最有价值的一步），**然后走导入 CLI 入库**（preview → 按需确认 → commit，与 PC 导入页同一契约，重复检测/合并规则全部由服务端执行）。

## 工作流

### 1. 收集与整理

从用户消息提取每个学习项，缺的信息可以合理补全（标注"我补的，可改"），但 **target / meaning / source_example 三项必须有**：

- `type`：`word`（单词）或 `chunk`（词块/搭配/短句）
- `target`：英文原文，保留用户的写法，不要翻译
- `meaning`：中文释义，**只取用户当前要学的这一个义项**（一词多义时按上下文选并注明；拿不准哪个是要学的义项就问用户）
- `source_example`：真实自然的英文例句（优先用用户给的原文句子；没有则你造一个简单自然的，标注"我造的"）
- 可选：`extra_examples`（补充例句数组）、`source`（出处，如 "Avatar S01E12"）、`source_url`、`tags`（字符串数组）、`notes`（中文备注）

组装成（每批建议 ≤ 20 条，太多就分批）：

```json
{
  "version": "1.2",
  "items": [
    {
      "type": "chunk",
      "target": "wear down",
      "meaning": "逐渐使……疲惫；消耗",
      "source_example": "It wears you down.",
      "extra_examples": [],
      "source": "Avatar S01E12",
      "tags": ["Avatar"],
      "notes": null
    }
  ]
}
```

### 2. 预览（服务端做重复检测与合并建议）

```bash
cd /var/www/english-review/apps/api && pnpm exec tsx scripts/el-cli.ts preview <file.json|->
```

（`-` = stdin。命令默认打本机服务 http://127.0.0.1:5174。登录密码读 `/etc/english-learning/env` 的 `AUTH_PASSWORD`——该文件 root-only，普通用户读不到时用 `IMPORT_PASSWORD=<密码> pnpm exec tsx ...` 注入，密码可 `sudo cat /etc/english-learning/env` 查看。）

### 3. 按需判断是否要问用户 —— 不要无条件确认

由你自行裁决：**只有出现需要用户拍板的情况才停下来问，否则直接 commit。**

直接 commit（不问），需同时满足：
- 所有条目的建议都是 `new_item` 或 `skip_exact_duplicate`
- 整理时没有拿不准的改写（meaning 是用户原意，或一词多义已按上下文选定并注明）

停下来等确认（列出具体调整点，把建议表原样转述：每条的 建议/理由/匹配到的已有项）：
- 任一条建议是 `merge`（会改动已有词卡内容）
- 关键内容是我补的且拿不准（如 meaning 靠猜、义项选择会影响学习目标）
- 建议与用户意图明显冲突（如用户明说想新增但服务端判合并/跳过）

用户说"直接导"时始终跳过确认。产品规则是"AI 只给建议，最终由用户确认"——确认义务由你按上述触发条件履行，而不是每轮都机械地问一句。

### 4. 提交

```bash
pnpm exec tsx scripts/el-cli.ts commit --token <preview 输出的 token> \
  [--decision 1=new_item] [--decision 2=skip_exact_duplicate]
```

不带 `--decision` = 全部按系统建议。action 取值：`merge`（合并）/ `new_item`（新增）/ `skip_exact_duplicate`（跳过）。

### 5. 报告

告诉用户结果（新增 n · 合并 n · 跳过 n）和一句下一步提示（新词进入 New Queue，Today 每天按额度引入）。直接 commit 而没经过确认轮时，把建议表（建议/理由）随报告附上，便于用户事后纠正。

## 注意

- **按需确认**：字段齐全且全部建议为新增时直接 commit 并在报告里附建议表，不要多问一轮；只有 `merge`、拿不准的改写、建议与意图冲突时才停下来等用户拍板。
- 同名不同义项是合法的重复导入场景（会由服务端 AI 判定 new_item），不要自行去重。
- preview token 2 小时过期、一次性；过期就重新 preview。
- 失败排查：`IMPORT_API_BASE` / `IMPORT_PASSWORD` 环境变量可覆盖目标与密码；服务状态 `systemctl status english-learning-api`。
