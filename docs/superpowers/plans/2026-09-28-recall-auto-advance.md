# Recall 评分即前进 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recall 自评（想起来了/没想起来）提交成功且 `/api/today` 刷新成功后自动进入下一题，去掉多余的一次「下一题」点击；坏题入口移到任务列表回看。

**Architecture:** 纯前端。`FrozenAnswer` 增加 `autoAdvance` 标记，自评回调逐层透传到 TodayPage；TodayPage 监听该标记，`refetch()` 成功才 `advance()`，失败停留现有冻结反馈页人工兜底。回看模式 `onAdvance` 修复为返回当前题。规格：`docs/superpowers/specs/2026-09-28-recall-auto-advance-design.md`。

**Tech Stack:** React + TanStack Query + vitest + testing-library + Playwright。

## Global Constraints

- 本仓库 TDD 强制（AGENTS.md §9）：先改测试看它失败，再改实现。
- 宣称完成前必须通过：`pnpm lint && pnpm typecheck && pnpm test`；UI 流程加 e2e。
- 样式不加新 token/颜色；不改后端 API 与 packages/shared。
- 本机 1.9G 内存（历史上有构建 OOM 冻结）：e2e 必须 `--workers=1`，不要并行跑多个构建/测试进程。
- 提交信息用仓库惯例（中文 conventional commits），带 HAPI 署名（见各任务 commit 步骤）。

---

### Task 1: 自评自动前进核心链路 + 受影响单测 + 产品文档

**Files:**
- Modify: `apps/web/src/features/today/components/RecallCard.tsx`（Props.onAnswered 签名 + 两键回调）
- Modify: `apps/web/src/features/today/components/TaskCard.tsx:17`（Props.onAnswered 签名）
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx`（FrozenAnswer 类型、handleAnswered、reviewing 分支 onAdvance）
- Modify: `apps/web/src/features/today/TodayPage.tsx`（autoAdvance effect）
- Modify: `apps/web/src/features/today/components/ChoiceQuestionView.tsx`、`ClozeQuestionView.tsx`、`ProductionQuestionView.tsx`（无需改动；其 `onAnswered` 形参为 `(result) => void`，传入更宽签名兼容）
- Test: `apps/web/tests/today-recall.test.tsx`、`apps/web/tests/today-choice.test.tsx`、`apps/web/tests/today-navigation.test.tsx`、`apps/web/tests/today-active.test.tsx`
- Modify: `docs/PRODUCT_DESIGN.md`（§7.1）

**Interfaces:**
- Consumes: 现有 `useAnswer().mutate({ taskId, body }, { onSuccess })`、`useTodayStatus().refetch()`、`FrozenAnswer`（ActiveSession 导出，TodayPage 消费）。
- Produces:
  - `type AnsweredOpts = { autoAdvance?: boolean }`
  - `FrozenAnswer = { task: TodayTaskView; result: AnswerResponse; autoAdvance?: boolean }`
  - `RecallCard/TaskCard` 的 `onAnswered: (result: AnswerResponse, opts?: AnsweredOpts) => void`
  - 仅 Recall 自评两键传 `{ autoAdvance: true }`；Hint 与其他题型不传。

- [ ] **Step 1: 改 today-recall.test.tsx——自评两键改为自动前进断言（RED）**

替换 `it('显示答案：... 点想起来了 → POST {recall:"recalled"} → 冻结"想起来了"'` 整个用例（现第 66-110 行）为：

```tsx
  it('显示答案：meaning 展示、[没想起来][想起来了]；点想起来了 → POST {recall:"recalled"} → 自动进入下一题', async () => {
    const withNotes = makeChoiceTask({
      item: { id: 'item-1', type: 'word', target: 'stable', meaning: '稳定的', ipa: '/ˈsteɪbl/', notes: '也作名词：马厩' },
    });
    const statusQueue = [makeActive(withNotes)];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
      '/api/today/tasks/task-1/answer': recalledAnswer(),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    expect(await screen.findByText('稳定的')).toBeVisible();
    expect(screen.getByRole('button', { name: '没想起来' })).toBeVisible();
    expect(screen.getByRole('button', { name: '想起来了' })).toBeVisible();
    const notesDetails = screen.getByText('笔记').closest('details');
    expect(notesDetails).toHaveAttribute('open');
    expect(notesDetails).toHaveTextContent('也作名词：马厩');
    expect(screen.queryByRole('button', { name: '给我提示' })).not.toBeInTheDocument();

    // 评分即前进：不出现"下一题"，refetch 落地即切下一张卡
    fireEvent.click(screen.getByRole('button', { name: '想起来了' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({
      recall: 'recalled',
    });
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '下一题' })).not.toBeInTheDocument();
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
  });
```

替换 `it('没想起来：POST {recall:"forgot"} → 冻结显示正确 meaning + source_example 突出'`（现第 112-134 行）为：

```tsx
  it('没想起来：POST {recall:"forgot"} → 自动进入下一题（释义在揭示态已看过）', async () => {
    const statusQueue = [makeActive(makeChoiceTask(), { completed: 1, total: 4 })];
    stubApi({
      '/api/today': () =>
        statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
      '/api/today/tasks/task-1/answer': forgotAnswer(),
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '没想起来' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/answer')).toHaveLength(1);
    });
    expect(jsonBodyOf(apiCalls('/api/today/tasks/task-1/answer')[0])).toEqual({
      recall: 'forgot',
    });
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
  });
```

替换两个「历史 outcomeSource=NULL」用例（现第 229-258 行）为「refetch 失败兜底」两用例（同时覆盖失败兜底与历史回退判定文案）：

```tsx
  it('refetch 失败：自评后停留冻结反馈（历史 outcomeSource=NULL 回退"想起来了"），下一题/坏题兜底仍在', async () => {
    let answered = false;
    stubApi({
      '/api/today': () => {
        if (!answered) return makeActive(makeChoiceTask(), { completed: 1, total: 4 });
        throw new Error('network down');
      },
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return makeCorrectAnswer(); // 无 outcomeSource → 历史回退
      },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '想起来了' }));

    const verdict = await verdictParagraph('想起来了');
    expect(verdict.className).toContain('text-success');
    expect(screen.queryByText('没想起来')).not.toBeInTheDocument();
    // 刷新失败不自动前进：人工兜底入口仍在
    expect(screen.getByRole('button', { name: '下一题' })).toBeVisible();
    expect(screen.getByRole('button', { name: '坏题' })).toBeVisible();
  });

  it('refetch 失败：历史 outcomeSource=NULL 回退"没想起来"+释义揭示', async () => {
    let answered = false;
    stubApi({
      '/api/today': () => {
        if (!answered) return makeActive(makeChoiceTask(), { completed: 1, total: 4 });
        throw new Error('network down');
      },
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return makeWrongAnswer(); // 无 outcomeSource → 历史回退
      },
    });
    renderTodayApp();

    fireEvent.click(await screen.findByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '没想起来' }));

    const verdict = await verdictParagraph('没想起来');
    expect(verdict.className).toContain('text-destructive');
    expect(screen.getByText('稳定的')).toBeVisible();
    expect(screen.getByText('The ladder feels stable.')).toBeVisible();
    expect(screen.getByRole('button', { name: '下一题' })).toBeVisible();
  });
```

替换 learn 用例（`describe('learn 分派 RecallCard…')` 内，现第 285-323 行）末尾「冻结反馈 + 手动下一题」段（从 `// 冻结反馈 + 词行不重复` 到用例结束）为：

```tsx
    // 评分即前进：refetch 落地自动到下一张卡（learn 与 understanding 同路径）
    expect(await screen.findByRole('heading', { name: 'ambitious' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'gravity' })).not.toBeInTheDocument();
    expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
```

（learn 用例开头 `statusQueue` 已具备，无需改 stub。Hint 两用例与 readOnly 两用例不动。）

- [ ] **Step 2: 改 today-choice.test.tsx 的「答对」用例（RED）**

替换 `it('答对：不自动跳题，点"下一题"按钮推进（与答错统一）'`（现第 101-140 行）为：

```tsx
  it('答对：refetch 成功后自动推进（评分即前进，无需点下一题）', async () => {
    vi.useFakeTimers();
    try {
      const statusQueue = [makeActive(makeLearnTask())];
      stubApi({
        '/api/today': () =>
          statusQueue.shift() ?? makeActive(secondTask(), { completed: 1, total: 2 }),
        '/api/today/tasks/task-learn/answer': makeCorrectAnswer(),
      });
      renderTodayApp();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
      fireEvent.click(screen.getByRole('button', { name: '想起来了' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByRole('heading', { name: 'stable' })).toBeVisible();
      expect(apiMock.mock.calls.filter(([p]) => p === '/api/today')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
```

（若该文件未导入 `secondTask`/`makeLearnTask` 等请按既有 import 补；该文件已有 `act`、`apiMock`。）

- [ ] **Step 3: 改 today-navigation.test.tsx 两个用例（RED）**

替换 `it('答对：显示"下一题"按钮，点击推进；不再自动跳题'`（现第 172-209 行）为：

```tsx
  it('答对：refetch 成功后自动推进到下一题（评分即前进）', async () => {
    let answered = false;
    stubApi({
      '/api/today': () =>
        answered ? makeActive(t4, { completed: 3, total: 4 }) : makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': () =>
        answered
          ? makeTasksResponse([
              makeSessionEntry(t1, makeCorrectAnswer()),
              makeSessionEntry(t2, makeWrongAnswer()),
              makeSessionEntry(t3, makeCorrectAnswer()),
              makeSessionEntry(t4, null),
            ])
          : makeTasksResponse([
              makeSessionEntry(t1, makeCorrectAnswer()),
              makeSessionEntry(t2, makeWrongAnswer()),
              makeSessionEntry(t3, null),
              makeSessionEntry(t4, null),
            ]),
      '/api/today/tasks/task-3/answer': () => {
        answered = true;
        return makeCorrectAnswer({ outcomeSource: 'recalled' });
      },
    });
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '想起来了' }));
    // 无需点"下一题"：refetch 落地即到第 4 题
    await screen.findByText('第 4 / 4');
    expect(screen.getByRole('heading', { name: 'delta' })).toBeVisible();
  });
```

替换 `it('冻结错配回归：答错后 refetch 落地仍显示原题反馈，坏题提交到原题 taskId'`（现第 125-170 行）为回看坏题用例：

```tsx
  it('坏题入口在回看：自评自动前进后，列表回看已答题可标记坏题并返回当前题', async () => {
    let answered = false;
    stubApi({
      '/api/today': () =>
        answered ? makeActive(t4, { completed: 3, total: 4 }) : makeActive(t3, { completed: 2, total: 4 }),
      '/api/today/tasks': () =>
        answered
          ? makeTasksResponse([
              makeSessionEntry(t1, makeCorrectAnswer()),
              makeSessionEntry(t2, makeWrongAnswer()),
              makeSessionEntry(t3, makeWrongAnswer()),
              makeSessionEntry(t4, null),
            ])
          : makeTasksResponse([
              makeSessionEntry(t1, makeCorrectAnswer()),
              makeSessionEntry(t2, makeWrongAnswer()),
              makeSessionEntry(t3, null),
              makeSessionEntry(t4, null),
            ]),
      '/api/today/tasks/task-3/answer': () => {
        answered = true;
        return makeWrongAnswer();
      },
      '/api/today/tasks/task-3/bad-question': { ok: true, progress: { completed: 2, total: 4 } },
    });
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    // 自评答错 → 自动前进到第 4 题
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '没想起来' }));
    await screen.findByText('第 4 / 4');
    expect(screen.getByRole('heading', { name: 'delta' })).toBeVisible();

    // 回看 t3（gamma）：冻结反馈 + 坏题入口；坏题必须提交到被回看的 task-3
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /gamma/ }),
    );
    await screen.findByText('第 3 / 4');
    fireEvent.click(screen.getByRole('button', { name: '坏题' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-3/bad-question')).toHaveLength(1);
    });
    expect(apiCalls('/api/today/tasks/task-4/bad-question')).toHaveLength(0);
    // 坏题成功后返回当前题
    await screen.findByText('第 4 / 4');
    expect(screen.getByRole('heading', { name: 'delta' })).toBeVisible();
  });
```

- [ ] **Step 4: 改 today-active.test.tsx 的坏题用例（RED）**

替换 `it('坏题：confirm 流程后 POST bad-question、撤销并刷新'`（现第 37-90 行）为：

```tsx
  it('坏题：自评前进后在回看中标记，confirm 流程 POST bad-question 并返回当前题', async () => {
    let answered = false;
    const nextTask = makeChoiceTask({
      taskId: 'task-2',
      question: {
        questionId: 'q-2',
        kind: 'direct_meaning',
        context: null,
        question: '"make sense" 的意思是？',
        options: [
          { id: 'm1', text: '讲得通' },
          { id: 'm2', text: '毫无意义' },
        ],
      },
    });
    const first = makeChoiceTask();
    stubApi({
      '/api/today': () =>
        answered
          ? makeActive(nextTask, { completed: 1, total: 4 })
          : makeActive(first, { completed: 1, total: 4 }),
      '/api/today/tasks': () =>
        answered
          ? makeTasksResponse([makeSessionEntry(first, makeWrongAnswer()), makeSessionEntry(nextTask, null)])
          : makeTasksResponse([makeSessionEntry(first, null), makeSessionEntry(nextTask, null)]),
      '/api/today/tasks/task-1/answer': () => {
        answered = true;
        return makeWrongAnswer();
      },
      '/api/today/tasks/task-1/bad-question': { ok: true, progress: { completed: 1, total: 4 } },
    });
    renderTodayApp();

    // 答题前没有坏题入口
    await screen.findByRole('heading', { name: 'stable' });
    expect(screen.queryByRole('button', { name: '坏题' })).not.toBeInTheDocument();

    // 显示答案 → 没想起来 → 自动前进到 make sense
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '没想起来' }));
    expect(await screen.findByRole('heading', { name: 'make sense' })).toBeVisible();

    // 回看 stable → 坏题 confirm → POST task-1
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '任务列表' })).getByRole('button', { name: /stable/ }),
    );
    expect(await screen.findByRole('button', { name: '坏题' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '坏题' }));
    const dialog = screen.getByRole('dialog', { name: '标记坏题' });
    expect(screen.getByText('标记坏题将撤销本次作答影响')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));

    await waitFor(() => {
      expect(apiCalls('/api/today/tasks/task-1/bad-question')).toHaveLength(1);
    });
    expect(apiCalls('/api/today/tasks/task-1/bad-question')[0].init).toMatchObject({ method: 'POST' });
    // 返回当前题 make sense
    expect(await screen.findByRole('heading', { name: 'make sense' })).toBeVisible();
  });
```

如该文件未导入 `makeSessionEntry`、`makeTasksResponse`、`within`，在顶部既有 import 中补齐。

- [ ] **Step 5: 跑单测确认按预期失败**

Run: `cd /var/www/english-review && pnpm --filter @el/web run test 2>&1 | tail -40`
Expected: 上述改动用例 FAIL（如「Unable to find role heading "ambitious"」「找不到 下一题 button」等）；其余用例 PASS。

- [ ] **Step 6: 实现四个文件（GREEN）**

`apps/web/src/features/today/components/RecallCard.tsx`：

```tsx
interface Props {
  task: TodayTaskView;
  /** Hint 用的四选一（任务绑定题目） */
  question: ChoiceQuestion;
  result: AnswerResponse | null;
  outcomeSource: AnswerResponse['outcomeSource'];
  readOnly?: boolean;
  onAnswered: (result: AnswerResponse, opts?: { autoAdvance?: boolean }) => void;
  onAdvance: () => void;
}
```

`submit` 与两键 onClick：

```tsx
  function submit(body: AnswerRequest, opts?: { autoAdvance?: boolean }) {
    answer.mutate({ taskId: task.taskId, body }, { onSuccess: (result) => onAnswered(result, opts) });
  }
```

```tsx
            <Button
              variant="outline"
              className="flex-1"
              disabled={answer.isPending}
              onClick={() => submit({ recall: 'forgot' }, { autoAdvance: true })}
            >
              没想起来
            </Button>
            <Button
              className="flex-1"
              disabled={answer.isPending}
              onClick={() => submit({ recall: 'recalled' }, { autoAdvance: true })}
            >
              想起来了
            </Button>
```

Hint 的 `onSubmitOption={(optionId) => submit({ selectedOptionId: optionId, hintUsed: true })}` 不变（不传 opts）。

`apps/web/src/features/today/components/TaskCard.tsx` Props：

```tsx
  onAnswered?: (result: AnswerResponse, opts?: { autoAdvance?: boolean }) => void;
```

（RecallCard/ChoiceQuestionView/ClozeQuestionView/ProductionQuestionView 的接线不动——更宽的函数可赋给窄签名。）

`apps/web/src/features/today/components/ActiveSession.tsx`：

```tsx
export interface FrozenAnswer {
  task: TodayTaskView;
  result: AnswerResponse;
  autoAdvance?: boolean;
}
```

```tsx
  const handleAnswered = useCallback(
    (task: TodayTaskView, result: AnswerResponse, opts?: { autoAdvance?: boolean }) => {
      setCursor(null); // 确保回到当前
      onAnswered({ task, result, autoAdvance: opts?.autoAdvance });
    },
    [onAnswered],
  );
```

TaskCard 接线与 reviewing 分支 onAdvance：

```tsx
          onAnswered={reviewing ? undefined : (result, opts) => handleAnswered(shownTask, result, opts)}
          onAdvance={reviewing ? () => setCursor(null) : onAdvance}
```

`apps/web/src/features/today/TodayPage.tsx`：`useCallback` 所在 import 行加入 `useEffect`，组件内 advance 定义之后加：

```tsx
  // Recall 评分即前进：自评后等状态刷新成功再 advance；失败停留反馈页人工兜底
  useEffect(() => {
    if (!frozen?.autoAdvance) return;
    void refetch().then((res) => {
      if (!res.isError) advance();
    });
  }, [frozen, refetch, advance]);
```

- [ ] **Step 7: 跑单测确认全绿**

Run: `cd /var/www/english-review && pnpm --filter @el/web run test 2>&1 | tail -15`
Expected: 全部 PASS（0 failed）。若有本计划外用例失败，先判断是否同属旧「冻结+手动下一题」假设，按同一模式修，并在 commit message 说明。

- [ ] **Step 8: 更新 PRODUCT_DESIGN.md §7.1**

在 §7.1 第一个流程代码块（`forgot/assisted 明日以 Recall 短间隔回归` 行，约第 163 行）之后、`## 4.3` 之前插入：

```markdown
评分即前进（2026-09-28）：Recall 自评提交成功且 Today 状态刷新后自动进入下一题；刷新失败停留在反馈页（下一题/坏题人工兜底）。误评可在 任务列表 → 回看 → 坏题 撤销本次影响。
```

- [ ] **Step 9: lint + typecheck + 提交**

Run: `cd /var/www/english-review && pnpm lint && pnpm typecheck`
Expected: 均无错误。

```bash
cd /var/www/english-review
git add apps/web/src/features/today apps/web/tests/today-recall.test.tsx apps/web/tests/today-choice.test.tsx apps/web/tests/today-navigation.test.tsx apps/web/tests/today-active.test.tsx docs/PRODUCT_DESIGN.md
git commit -m "$(cat <<'EOF'
feat(web): Recall 评分即前进——自评后 refetch 成功自动进下一题，坏题入口移至回看

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: e2e 适配 + 全量门禁 + 推送

**Files:**
- Modify: `apps/web/e2e/today.spec.ts`（answerRecall 助手及各调用点）
- Modify: `apps/web/e2e/production.spec.ts`（两处 Recall 卡步行循环）

**Interfaces:**
- Consumes: Task 1 交付的行为（自评后自动切卡）。
- Produces: 无（验证性任务）。

- [ ] **Step 1: 改 e2e/today.spec.ts 的 answerRecall 助手**

现助手（约第 38-46 行）：

```ts
/** understanding Recall：recalled 路径——显示答案 → 自评"想起来了" → 评分即前进 */
async function answerRecall(page: Page) {
  await page.getByRole('button', { name: '显示答案' }).click();
  await page.getByRole('button', { name: '想起来了' }).click();
  // 自动前进：等自评按钮消失（冻结瞬态或已切卡）
  await expect(page.getByRole('button', { name: '想起来了' })).toHaveCount(0);
}
```

（删除原「冻结"想起来了"文案可见」与「点下一题」两行；函数签名行按文件现有写法保留。）然后检查每个调用点：其后原本等待下一张卡特征的断言已存在则不动；若调用点后面还跟着 `下一题` 点击则删除。重点核对：Learn 卡（gravity）后接填空 raw、make sense 后接 stable（显示答案按钮，非自评按钮，不冲突）、同日追加 delta 卡、导航测试。

- [ ] **Step 2: 改 e2e/production.spec.ts 两处 Recall 步行分支**

分支 2（gravity，约第 72-81 行）与分支 4（约第 93-101 行），把：

```ts
        await page.getByRole('button', { name: '想起来了' }).click();
        await page.getByRole('button', { name: '下一题' }).click();
        continue;
```

统一改为：

```ts
        await page.getByRole('button', { name: '想起来了' }).click();
        // 评分即前进：等自评按钮消失即已切卡
        await expect(page.getByRole('button', { name: '想起来了' })).toHaveCount(0);
        continue;
```

分支内注释同步改为「显示答案 → 想起来了 → 评分即前进」。hint 选错分支（today.spec 内 `冻结"没想起来"` 后点下一题那段）是 Hint 路径，**保持手动下一题，不要改**。

- [ ] **Step 3: 跑受影响的 e2e**

Run: `cd /var/www/english-review/apps/web && pnpm exec playwright test today.spec.ts production.spec.ts --workers=1`
Expected: 全部 PASS。（本机内存受限，必须 --workers=1，且不要同时跑别的构建。）

- [ ] **Step 4: 全量门禁**

Run: `cd /var/www/english-review && pnpm lint && pnpm typecheck && pnpm test`
Expected: 全部通过。

- [ ] **Step 5: 提交并推送**

```bash
cd /var/www/english-review
git add apps/web/e2e/today.spec.ts apps/web/e2e/production.spec.ts
git commit -m "$(cat <<'EOF'
test(web): e2e 适配 Recall 评分即前进——自评后不再点下一题，等待自动切卡

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
git push origin main
```

- [ ] **Step 6: 汇报（含部署提醒）**

向用户报告：行为变化点、测试结果。提醒：生产站点生效需跑 `deploy/deploy.sh`（内存最重操作，单独执行、避免并发）。

---

## Self-Review 记录

- 规格覆盖：§3 交互（Task 1 Step 6 + 测试）、§4.1 标记透传（Task 1 Step 6）、§4.2 refetch 时机（Task 1 Step 6 TodayPage effect；实现用 `refetch().then(res => !res.isError && advance())`——比规格伪代码更准确，因 v5 `refetch()` 不 reject 而是返回带 isError 的结果）、§4.3 坏题回看（Task 1 Step 6 reviewing 分支 + Step 3/4 测试）、§5 文档（Task 1 Step 8）、§6 测试（Step 1-5、Task 2）——无缺口。
- 占位符扫描：无 TBD/TODO；所有代码块完整可粘贴。
- 类型一致性：`{ autoAdvance?: boolean }` 内联类型在 RecallCard/TaskCard/ActiveSession 三处一致；`FrozenAnswer.autoAdvance` 与 TodayPage `frozen?.autoAdvance` 一致；e2e 无类型新增。
