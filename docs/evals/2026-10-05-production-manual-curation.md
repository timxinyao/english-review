# 存量表达人工校对 — 2026-10-05

## 结果与范围

用户明确请求按新版批改逻辑全量人工校对存量内容。本次逐条检查 10 条有答案的造句历史，更新其最小纠错、建议句、polish/rewrite 标签及关联正文；8 条现有个人例句更新，1 条不合格个人例句移除。另 1 条已撤销且无答案的记录保持原样。来源例句、额外例句和题库参考答案不属于本次旧批改内容，保持原样。

原答案、历史评分、学习进度、排期、统计和原模型／Prompt 元数据保留；人工复核结果、候选选择、时间、规则版本/hash 单独保存到 correction_json.manualRevision。本次没有调用真实模型、没有改 Prompt，也没有把人工记录伪装成新模型批改。已不存在的个人例句不重建；固定或正文与旧批改不同的例句受保护，本批未遇到此类保护项。

## 逐条校对

| 表达 | 纠正后 | 建议句 | 类型 | 现有个人例句 |
| --- | --- | --- | --- | --- |
| Is it just me, or...? | Is it just me, or does he speak really fast? | — | 无需额外改写 | 更新 |
| concerned with | This book is concerned with how to protect the environment. | — | 无需额外改写 | 更新 |
| As far as I'm concerned | As far as I'm concerned, feeding a dog is actually good. | As far as I'm concerned, having a dog is actually a good idea. | 参考表达 | 移除不合格正文；历史保留 |
| concerned about | I'm concerned about you, my friend. | — | 无需额外改写 | 更新 |
| doze off | I dozed off last night, the TV still running when I woke up. | I dozed off last night, and the TV was still on when I woke up. | 润色 | 更新 |
| hit the hay | I'm gonna hit the hay because I have to get up early to take the train. | — | 无需额外改写 | 更新 |
| come up with | I'll come up with a nice new plan so that we can go out and play together next month. | — | 无需额外改写 | 更新 |
| get one's butt kicked | We got our butt kicked during the basketball game. | — | 无需额外改写 | 更新 |
| wear down | I was worn down more and more. | I was getting more and more worn down. | 润色 | 没有现存例句，不新建 |
| honored guests | Welcome to every honored guest at our wedding. | Welcome to our wedding, honored guests! | 润色 | 更新 |

`feeding a dog` 表示“喂狗”，原题要求表达“养狗”的看法。最小纠错保留 feeding，不擅自换成 having；养狗的表达仅作为 rewrite 参考，不符合个人例句资格，因此从个人例句移除。原作答和原 basic_pass 评分继续保留，人工复核的 fail 独立留档，不重算历史进度。

`honored guests` 的润色保留用户的欢迎语，不用原先“今天到场的每一位都是……”的陈述替代；`doze off` 和 `wear down` 的润色分别移除原答案没有写的看电视动作、天气／走路原因。`concerned with` 的纠正后已经自然，不再用加入 mainly 的参考句替代用户答案。

## 备份与执行验证

- 备份目录：`/var/lib/english-learning/backups/manual-production-20261005/`。整库一致快照为 `before.db`，同时保留 before.json、plan.json、patches.json、after.json、维护脚本和测试。
- before.db SHA-256：`ddded10e5a2102d0edae91cf519ec7fd684fce7f1ab1363f2e4e4a43ac6c763a`。
- 维护测试先失败再实现，最终 6 项通过：全量范围／保存选择、精确 diff 重建、rewrite 排除、固定／编辑保护、输入冲突拒绝、事务并发保护与重复执行保护。
- 10/10 人工记录通过现行 CheckProductionResult Zod 与原句／纠正后精确重建校验。
- 在整库副本先演练，逐表核对仅修改清单中的 attempts 与个人 learning_examples，其他表完全一致。
- 线上短事务写入前比较原行，冲突拒绝整批；写入后再次核对实际数据与演练清单一致，SQLite integrity_check 与 foreign_key_check 通过。
- 备份目录含逐行回滚脚本 rollback.py：只还原本次维护行，遇到后续用户编辑拒绝回滚；在副本验证原行值可完整恢复，不覆盖其他业务数据。
- 10/10 词条的认证 HTTPS Library API 返回纠正句、建议句、类型和个人例句与清单一致；历史评分和原文一致，服务健康正常。
- 无应用源码修改或数据库迁移，数据写入立即生效，无需重新部署。未提交或推送。
