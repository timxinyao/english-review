---
name: import-english
description: 通过对话把用户想学的英语单词/词块导入 English Review 学习库。把聊天里零散的内容（词汇列表、笔记、一段生词、带例句的材料）整理成标准导入 JSON，调用学习库导入 API 预览重复并提交入库。当用户说"导入/记一下这些词/加入学习库/我想学这些表达/录入/import 这些词"，或在英语学习对话中用户给出了一批想学的词时使用。
---

# import-english：对话式导入学习项

你负责两件事：**把用户零散的内容整理成标准导入 JSON**（这是你的语言能力最有价值的一步），**然后走导入 CLI 入库**（preview → 用户确认 → commit，与 PC 导入页同一契约，重复检测/合并规则全部由服务端执行）。

## 工作流

### 1. 收集与整理

从用户消息提取每个学习项，缺的信息可以合理补全（标注"我补的，可改"），但 **target / meaning / source_example 三项必须有**：

- `type`：`word`（单词）或 `chunk`（词块/搭配/短句）
- `target`：英文原文，保留用户的写法，不要翻译
- `meaning`：中文释义，**只取用户当前要学的这一个义项**（一词多义时问一下用户，或按上下文选并注明）
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
cd /var/www/english-review/apps/api && echo '<上述 JSON>' | pnpm exec tsx scripts/import-cli.ts preview
```

（也可以先把 JSON 写临时文件再 `preview <file>`。命令默认打本机服务 http://127.0.0.1:5174，密码自动从 env 读，无需额外配置。）

### 3. 展示建议并等用户确认 —— 必须做，不能跳过

把 preview 的建议表**原样转述**给用户（每条的 建议/理由/匹配到的已有项），然后问一句确认。产品规则是"AI 只给建议，最终由用户确认"。用户可以说"第 2 条改成新增"之类。

### 4. 提交

```bash
pnpm exec tsx scripts/import-cli.ts commit --token <preview 输出的 token> \
  [--decision 1=new_item] [--decision 2=skip_exact_duplicate]
```

不带 `--decision` = 全部按系统建议。action 取值：`merge`（合并）/ `new_item`（新增）/ `skip_exact_duplicate`（跳过）。

### 5. 报告

告诉用户结果（新增 n · 合并 n · 跳过 n）和一句下一步提示（新词进入 New Queue，Today 每天按额度引入）。

## 注意

- **commit 前必须把建议表给用户看过并得到确认**；用户明确说"直接导"时可跳过确认。
- 同名不同义项是合法的重复导入场景（会由服务端 AI 判定 new_item），不要自行去重。
- preview token 2 小时过期、一次性；过期就重新 preview。
- 失败排查：`IMPORT_API_BASE` / `IMPORT_PASSWORD` 环境变量可覆盖目标与密码；服务状态 `systemctl status english-learning-api`。
