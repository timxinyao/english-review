# Recall Card 主动回忆改造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Understanding 复习从默认四选一改为 Recall Card（主动回忆优先，选择题降级为 Hint），三档证据 recalled/assisted/forgot 复用 pass/basic_pass/fail 调度，底层数据可区分。

**Architecture:** shared schema 扩两个可选字段；answerTodayTask understanding 分支重写判定；attempts 加一列 outcome_source；web 新增 RecallCard 并在 TaskCard 分派；Learn/Fill/Production/Read/调度/补强全部不动。

**Tech Stack:** 同前（Fastify/drizzle/better-sqlite3、React 18、vitest、Playwright）。

**规格：** `docs/superpowers/specs/2026-09-27-recall-card-design.md`

## Global Constraints

- 仓库根：`/var/www/english-review`；API 单测 `pnpm --filter @el/api run test`、web 单测 `pnpm --filter @el/web run test` 全过；双侧 typecheck 无错误。
- e2e：`E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "<片段>"`。
- 服务器仅 1.9G 内存：禁止单测与 e2e 并发跑；构建带 `NODE_OPTIONS=--max-old-space-size=768`。
- 调度只允许现有三种 kind：pass/basic_pass/fail；不得新增 scheduler 分支。
- 提交信息末尾加：
  ```
  via [HAPI](https://hapi.run)

  Co-Authored-By: HAPI <noreply@hapi.run>
  ```
- 不要 push、不要部署（编排者统一做）。

---

### Task 1: shared schema + API 判定分支 + outcome_source 列

**Files:**
- Modify: `packages/shared/src/schemas/api/today.ts:120-140`（AnswerRequest/AnswerResponse）
- Modify: `apps/api/src/db/schema.ts`（attempts 加列）
- Create: `apps/api/drizzle/0004_*.sql`（drizzle-kit generate）
- Modify: `apps/api/src/modules/today/service.ts`（answerTodayTask understanding 分支 + replayAnswer + attempts 写入）
- Test: today answer 相关单测（grep 定位，含 integration/today.test.ts）

**Interfaces:**
- Produces:
  - `AnswerRequest = { selectedOptionId?, answerText?, viewedSource?, recall?: 'recalled'|'forgot', hintUsed?: boolean }`
  - `AnswerResponse.outcomeSource?: 'recalled'|'assisted'|'forgot' | null`
  - attempts 列 `outcome_source TEXT NULL`；`insertAttempt`（或现有写入点）增加该字段入参。

- [ ] **Step 1: 写失败单测**

在 today answer 测试文件（先 grep `answerTodayTask|/answer` 于 apps/api/tests 定位主文件）新增/改写用例（沿用现有 seed/task 构造手法）：

```ts
describe('understanding Recall 判定', () => {
  it('recalled：body.recall=recalled → result=pass、advance kind=pass、attempt.outcome_source=recalled', async () => {
    // 构造 understanding 复习任务（非 learn）
    // POST answer {recall:'recalled'}
    // 断言 res.result==='pass' && res.outcomeSource==='recalled'
    //      attempts 表该行 outcome_source==='recalled'
  });
  it('forgot：body.recall=forgot → result=fail、补强插入（quota 允许时）', async () => { /* 同上断言 fail/forgot */ });
  it('assisted：hintUsed+选对 → result=basic_pass、outcome_source=assisted、不因 viewedSource 变化', async () => {
    // POST {selectedOptionId:<正确项>, hintUsed:true, viewedSource:true}
    // 断言 result==='basic_pass'（旧逻辑 viewedSource 会 basic_pass，此处即便 viewedSource=false 也应 basic_pass——补一例 false）
  });
  it('hint 后选错 → result=fail、outcome_source=forgot、揭示正确项', async () => {});
  it('learn 首题路径不变：选对且无 recall/hintUsed → pass、outcome_source 为空', async () => {});
  it('幂等回放：重复提交返回首次 outcomeSource', async () => {});
});
```

（断言 advance kind：现有测试通过 fake deps.advance 记录 kind 的手法沿用；无此手法则断言 result 与 attempt 落库即可。）

- [ ] **Step 2: 跑单测确认 RED**

Run: `pnpm --filter @el/api run test -- today`
Expected: 新用例 FAIL（无 recall 字段/outcomeSource/列不存在）。

- [ ] **Step 3: 实现**

3a. `packages/shared/src/schemas/api/today.ts`：

```ts
export const AnswerRequest = z.object({
  selectedOptionId: z.string().min(1).optional(),
  answerText: z.string().min(1).max(500).optional(),
  viewedSource: z.boolean().optional(),
  /** Understanding Recall Card：主动回忆直判（与 selectedOptionId 二选一） */
  recall: z.enum(['recalled', 'forgot']).optional(),
  /** Understanding Hint 模式提交的选择题标识 */
  hintUsed: z.boolean().optional(),
});
```

AnswerResponse 增字段（放在 result 之后）：

```ts
  /** understanding 三档证据：recalled=自答想起 / assisted=提示后对 / forgot=未想起或提示仍错；其余题型 null */
  outcomeSource: z.enum(['recalled', 'assisted', 'forgot']).nullable().optional(),
```

3b. `apps/api/src/db/schema.ts` attempts 表 `feedback` 列后加：

```ts
    /** understanding 证据来源：recalled | assisted | forgot；其余题型与历史行为 NULL */
    outcomeSource: text('outcome_source'),
```

生成迁移：`pnpm --filter @el/api exec drizzle-kit generate`（不可用则照 0003 风格手写 0004 SQL：`ALTER TABLE \`attempts\` ADD \`outcome_source\` text;` + meta journal/snapshot 补条目）。

3c. `answerTodayTask`：校验段（isCloze/isProduction 分支后）增加 understanding 分支——把现有

```ts
  if (!isCloze && !isProduction && !body.selectedOptionId) {
    throw appError('VALIDATION_ERROR', '选择题必须提交 selectedOptionId');
  }
```

改为：

```ts
  const isUnderstandingRecall = task.taskType === 'understanding';
  if (!isCloze && !isProduction && !isUnderstandingRecall && !body.selectedOptionId) {
    throw appError('VALIDATION_ERROR', '选择题必须提交 selectedOptionId');
  }
  if (isUnderstandingRecall && !body.recall && !body.selectedOptionId) {
    throw appError('VALIDATION_ERROR', 'Recall 题必须提交 recall 或 selectedOptionId');
  }
```

评估段 else 分支（evaluateChoice 处）与 result 计算改为：

```ts
  } else if (body.recall) {
    // Recall Card 直判：主动回忆（无提示）
    outcome = { correct: body.recall === 'recalled' };
  } else {
    outcome = deps.evaluateChoice(question, body.selectedOptionId!);
  }
  const correct = outcome.correct === true;
  const viewedSource = body.viewedSource === true;
  // understanding：recall→pass/fail；hint 选择→对=assisted(basic_pass)/错=forgot(fail)；
  // 查看原句不再降档（Recall 卡默认展示 source_example）。learn/cloze 旧语义不变。
  let outcomeSource: 'recalled' | 'assisted' | 'forgot' | null = null;
  let result: AnswerResponse['result'];
  if (isProduction) {
    result = production!.result;
  } else if (isUnderstandingRecall) {
    if (body.recall) {
      outcomeSource = body.recall;
      result = correct ? 'pass' : 'fail';
    } else {
      outcomeSource = correct ? 'assisted' : 'forgot';
      result = correct ? 'basic_pass' : 'fail';
    }
  } else {
    result = correct ? (viewedSource ? 'basic_pass' : 'pass') : 'fail';
  }
```

（AnswerResponse 返回对象与事务内 attempt 写入点均带 `outcomeSource`；事务内 attempt insert 的 values 增加 `outcomeSource`——定位现有 insert(attempts) 处加一个字段即可；replayAnswer 的返回对象补 `outcomeSource: (attempt?.outcomeSource as ...) ?? null`。）

- [ ] **Step 4: 跑单测确认 GREEN + 全量**

Run: `pnpm --filter @el/api run test` → 全过（既有 understanding 旧断言若有"选对=pass"需注意：understanding 旧用例若无 recall/hintUsed 字段仍走 choice 提交→现在会变 basic_pass！**既有 understanding 用例需按新语义更新**：普通 understanding 复习提交 choice = hint 语义。learn 用例不变。）

- [ ] **Step 5: typecheck + Commit**

```bash
git add packages/shared apps/api/src apps/api/drizzle apps/api/tests
git commit -m "feat(api): understanding Recall 判定——recall 直判与 hint 三档证据，复用 pass/basic_pass/fail 调度

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 2: Web RecallCard 与 TaskCard 分派

**Files:**
- Create: `apps/web/src/features/today/components/RecallCard.tsx`
- Modify: `apps/web/src/features/today/components/TaskCard.tsx`
- Test: `apps/web/tests/today-recall.test.tsx`（新建）、`apps/web/tests/today-choice.test.tsx`（understanding 部分改写/迁移）

**Interfaces:**
- Consumes: Task 1 的 `AnswerRequest.recall/hintUsed`、`AnswerResponse.outcomeSource`；`ChoiceQuestionCard`（hint 答题形态：`result=null`、不传 `onFeedback`）；`useAnswer`；`speak`。
- Produces: `<RecallCard task question result outcomeSource readOnly onAnswered onAdvance />`——onAnswered 收 `AnswerResponse`（与 ChoiceQuestionView 同约定）。

- [ ] **Step 1: 写失败单测（today-recall.test.tsx）**

沿用 today-helpers（makeChoiceTask 造 understanding 任务与题目；renderTodayApp + stubApi 模式同 today-choice.test.tsx，先读该文件开头抄手法）。用例：

```ts
describe('Recall Card（understanding）', () => {
  it('初始：显示 target/IPA/source_example 与 [给我提示][显示答案]，不显示 meaning 与选项', async () => {});
  it('显示答案：meaning 展示、notes 折叠、[没想起来][想起来了]；点想起来了 → POST {recall:"recalled"} → 冻结"想起来了"', async () => {});
  it('没想起来：POST {recall:"forgot"} → 冻结显示正确 meaning + source_example 突出', async () => {});
  it('Hint：点给我提示出现选择题；选对 → POST {selectedOptionId, hintUsed:true} → 冻结"提示后想起（基础通过）"', async () => {});
  it('Hint 选错 → 冻结"没想起来"+正确释义揭示', async () => {});
  it('readOnly 回看：直接呈现冻结态，无作答按钮', async () => {});
});
```

（每个用例给出具体断言：locator 文案/aria、apiCalls('/api/today/tasks/<id>/answer') 的 jsonBodyOf 匹配 recall/hintUsed 字段。）

- [ ] **Step 2: 跑单测确认 RED**

Run: `cd apps/web && pnpm exec vitest run today-recall` → FAIL。

- [ ] **Step 3: 实现**

3a. `RecallCard.tsx`（完整实现）：

```tsx
import { useState } from 'react';
import type { AnswerResponse, ChoiceQuestionView as ChoiceQuestion, TodayTaskView } from '@el/shared';
import { Volume2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { useAnswer } from '../api';
import { speak } from '../../../lib/tts';

interface Props {
  task: TodayTaskView;
  /** Hint 用的四选一（任务绑定题目） */
  question: ChoiceQuestion;
  result: AnswerResponse | null;
  outcomeSource: AnswerResponse['outcomeSource'];
  readOnly?: boolean;
  onAnswered: (result: AnswerResponse) => void;
  onAdvance: () => void;
}

/** Understanding Recall Card：主动回忆优先（PRODUCT §7.1 改版）；选择题降级为 Hint */
export function RecallCard({ task, question, result, outcomeSource, readOnly, onAnswered, onAdvance }: Props) {
  const answer = useAnswer();
  const [revealed, setRevealed] = useState(false);
  const [hint, setHint] = useState(false);

  const frozen = result !== null || readOnly;
  const word = task.item;
  const showSource = task.sourceExample !== null;

  function submit(body: Record<string, unknown>) {
    answer.mutate(
      { taskId: task.taskId, body },
      { onSuccess: onAnswered },
    );
  }

  return (
    <div className="space-y-4">
      {/* 词行（含手动发音） */}
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-semibold text-foreground">{word.target}</h3>
        {word.type === 'word' && word.ipa !== null && (
          <span className="text-sm text-muted-foreground">{word.ipa}</span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          aria-label="发音"
          onClick={() => void speak(word.target)}
        >
          <Volume2 className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {showSource && !frozen && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          <span className="mr-1 text-xs text-muted-foreground">原句</span>
          {task.sourceExample}
        </p>
      )}

      {/* 作答态 */}
      {!frozen && !hint && !revealed && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setHint(true)}>
            给我提示
          </Button>
          <Button size="sm" onClick={() => setRevealed(true)}>
            显示答案
          </Button>
        </div>
      )}

      {!frozen && !hint && revealed && (
        <div className="space-y-3">
          <p className="text-base text-foreground">{word.meaning}</p>
          {task.item /* notes 如可从 task 取到（见下方说明） */ }
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" disabled={answer.isPending} onClick={() => submit({ recall: 'forgot' })}>
              没想起来
            </Button>
            <Button className="flex-1" disabled={answer.isPending} onClick={() => submit({ recall: 'recalled' })}>
              想起来了
            </Button>
          </div>
        </div>
      )}

      {!frozen && hint && (
        <ChoiceQuestionCardHint question={question} pending={answer.isPending} onSubmitOption={(optionId) => submit({ selectedOptionId: optionId, hintUsed: true })} />
      )}

      {/* 冻结反馈（作答后/回看） */}
      {frozen && <RecallFeedback task={task} result={result} outcomeSource={outcomeSource} onAdvance={onAdvance} />}
    </div>
  );
}
```

（三个子块按此骨架落地：`ChoiceQuestionCardHint` 直接复用 `ChoiceQuestionCard`——`<ChoiceQuestionCard question target result={null} pending onSubmitOption onAdvance={onAdvance} />` 不传 onFeedback/sourceExample；`RecallFeedback` 按 outcomeSource 渲染：recalled→`想起来了`（success 色）+下一题按钮；assisted→`提示后想起（基础通过）`+下一题；forgot/其余→`没想起来`（destructive）+ 正确 meaning 揭示 + source_example 突出块（原句样式）+ 下一题按钮。readOnly 回看同用 RecallFeedback（无下一题按钮则由 TaskCard 外层处理——保持与现题型一致的 onAdvance 传入约定）。`notes`：查看 TodayTaskView 是否含 notes 字段——有则 `<details><summary>笔记</summary>{notes}</details>`；无则省略此块并在报告注明。）

3b. `TaskCard.tsx` 分派（替换 understanding 的 ChoiceQuestionView 分支）：

```tsx
          {question && 'options' in question ? (
            task.taskType === 'understanding' ? (
              <RecallCard
                task={task}
                question={question}
                result={result}
                outcomeSource={result?.outcomeSource ?? null}
                readOnly={readOnly}
                onAnswered={onAnswered ?? (() => {})}
                onAdvance={onAdvance ?? (() => {})}
              />
            ) : (
              <ChoiceQuestionView ... /* learn 首题，原样 */ />
            )
          ) : question && 'textWithBlank' in question ? (
```

（顶部"回看/已答词行"条件加 `&& task.taskType !== 'understanding'`，避免与 RecallCard 词行重复。）

- [ ] **Step 4: 跑单测确认 GREEN + 全量**

Run: `pnpm --filter @el/web run test`（today-choice 既有 understanding 用例按新流程改写——它们测的是 learn 首题则不变；测 understanding 复习的迁移到 today-recall.test.tsx 后删除旧用例）。

- [ ] **Step 5: typecheck + Commit**

```bash
git add apps/web/src/features/today apps/web/tests
git commit -m "feat(web): understanding Recall Card——主动回忆优先，选择题降级为 Hint

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 3: e2e 改写

**Files:**
- Modify: `apps/web/e2e/today.spec.ts`

- [ ] **Step 1: 改写主流程与相关用例**

1a. 主流程中 understanding 答题（stable / make sense / wear down 等）从点选项改为：

```ts
  /** understanding Recall：默认路径——显示答案后点"想起来了"（或按场景用 forgot/hint） */
  async function recallPass(page: Page) {
    await page.getByRole('button', { name: '显示答案' }).click();
    await expect(page.getByText('逐渐消耗', { exact: false })).toBeVisible(); // meaning 揭示（按具体词条替换）
    await page.getByRole('button', { name: '想起来了' }).click();
  }
```

- make sense（自动推进型用例）与 stable 各按需分配三条路径之一：主流程至少覆盖一条 recalled + 一条 forgot + 一条 hint（stable 首次答错改为：给我提示→选错误项→冻结显示正确释义→下一题；或 recall forgot 路径，择一并调整后续断言）。
- `continueAfterCorrect` helper：recalled 后点"下一题"按钮（RecallFeedback 冻结态的按钮），与现有 helper 合并或新增分支。
1b. '导航'/'倒计时' 用例中 make sense 答对段改 recall 路径（`显示答案→想起来了`）。
1c. 断言冻结反馈文案（想起来了/提示后想起/没想起来）与 forgot 的原句突出块。

- [ ] **Step 2: 跑 Today e2e**

Run: `E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "Today"` → 全过。

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/today.spec.ts
git commit -m "test(e2e): understanding 三路径（recalled/assisted/forgot）主流程改写

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```

---

### Task 4: 文档更新 + 全量验证（编排者执行）

- [ ] Step 1: PRODUCT_DESIGN §6.3/§7.1 understanding 描述改写（Recall Card 主动回忆优先、选择题=Hint、三档证据映射表），提交。
- [ ] Step 2: API/web 单测全过 + 双侧 typecheck + 全量 e2e + web build。
- [ ] Step 3: 部署 + 双入口验证 + 推送。
- [ ] Step 4: 按用户七问输出汇报。
