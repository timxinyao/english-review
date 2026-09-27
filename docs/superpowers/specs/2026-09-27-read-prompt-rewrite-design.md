# Read 生成提示词重写（恢复 5 词）— 设计

日期：2026-09-27 晚（用户质疑"别的产品十几个词都行"经实证成立后的纠正轮）

## 背景

上一轮把 READ_FOCUS_MAX 降为 3 属治标。实测（同模型 glm-5.3-flash、同样要求回抄 UUID）：手写直白英文 prompt 5 词全部成功（23.6s，正文/coverage 5/5）；项目 v1 长中文提示词 3 次重试全漏 coverage。结论：瓶颈在提示词结构，不在模型或词数。

## 改动

1. **重写 `apps/api/prompts/generate_read.v1.md`**（就地，文件名版本不变）：
   - 结构：开头即"硬性输出契约"（JSON only + coverage 必须逐一包含全部 focus 的 learning_item_id 原样回抄）→ focus 列表（UUID + target + meaning 逐行）→ 其余规则（篇幅 180–400 词、类型、checks 1–2 道、自然度、旧词自然融入不强求）→ 输出前自查清单（coverage 条数 = focus 条数、每个 UUID 逐字符核对）。
   - 关键约束前置、条目化、避免长段落堆叠；保留既有 JSON 示例结构与全部语义约束（surface_form 实际使用形式、checks correct_option_id 存在等），不放松任何不变式。
2. **`READ_FOCUS_MAX` 3 → 5**（回滚上一轮治标值，注释更新为实测结论）。
3. 同步 PRODUCT_DESIGN §Read 行（恢复"3～5 个"并注明提示词已按实测重写）。

## 验证（服务器侧真机等价）

用 `/tmp/repro-read3.mts` 同法（真实 `buildReadSelection` 5 词 + 完整 `completeStructured` 含 schema/不变式）连跑 **2 次成功**方算过（单次成功不足证）。

## 测试

- buildReadSelection 数量断言 3→5 回滚。
- 既有 read 生成单测（fake provider 断言 prompt 渲染的如有）按新 prompt 文本核对更新。

## 明确不做

- 不提高超过 5（规格 §8.1 上限；如需更多另议）。
- 不改 schema/不变式本身。
