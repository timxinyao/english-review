import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Today 复习全流程（PC viewport；E2E_SEED=1 播种：
 * V2：4 个到期任务（give up/make sense/stable/wear down）+ 1 个 New Queue 项 gravity）。
 * start 后会话为固定序（到期按 next_review_at+item.id，New Queue learn 殿后，混排不改变）：
 * give up 表达 → make sense 理解 → stable 理解 → wear down 理解 → gravity learn
 * understanding 与 learn 卡均为 Recall Card（PRODUCT §7.1"新词初见即回忆"）：主流程覆盖——
 * gravity（learn）与 make sense/wear down 走 recalled（显示答案→良好）、stable 走三档
 * 自评失败（显示答案→重来→评分即前进，错题记录进今日学习）；assisted（提示后想起）
 * 仅历史数据回放——2026-10-03 起三档自评（重来/良好/简单）、揭示前仅「显示答案」、
 * 无「给我提示」入口，学习流统一为 看词 → 显示答案 → 三选一。
 * 第三个用例覆盖同日追加学习（PRODUCT §3.4）：完成页"再学 N 个新词"→ extend → 新 Learn 卡（同 recall 路径）。
 */
test.use({ viewport: { width: 1280, height: 720 } });

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('访问密码').fill('e2e-password');
  await page.getByRole('button', { name: '进入' }).click();
  await page.waitForURL(/\/today$/);
}

/** 会话型 spec 共享同一 e2e.db，而一天只允许一个正式 session：开头重置回种子状态 */
async function resetSeedData(page: Page) {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/__e2e/reset', { method: 'POST', credentials: 'include' });
    return r.status;
  });
  if (res !== 200) throw new Error(`reset 失败：${res}`);
}

/** 答对/答错后：统一点"下一题"按钮推进（自动跳题已删除） */
async function continueAfterCorrect(page: Page) {
  const feedback = page.getByText('回答正确');
  await expect(feedback).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: '下一题' }).click();
}

/**
 * 新契约（2026-10-03 起）：start/extend 响应后后台一次性备好会话内全部造句题，
 * 到达客户端时多已绑定，不再触发客户端 prepare。模拟「预热未落地/失败」的 pending
 * 状态：剥离响应里 production 任务的绑定题，让客户端走占位卡 + prepare 失败路径。
 * 返回的 stop 在首个客户端 prepare 被拦截后调用，放行后续真实绑定（防重试后回弹占位卡）。
 */
async function stripBoundProduction(page: Page): Promise<() => void> {
  let stripping = true;
  const handler = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    const response = await route.fetch();
    const data = await response.json();
    if (stripping) {
      const strip = (task: { taskType?: string; question?: unknown } | null | undefined) => {
        if (task && task.taskType === 'production') task.question = null;
      };
      strip(data.currentTask ?? null);
      for (const entry of data.tasks ?? []) strip(entry.task);
    }
    await route.fulfill({ response, json: data });
  };
  await page.route('**/api/today', handler);
  await page.route('**/api/today/tasks', handler);
  return () => {
    stripping = false;
  };
}

/** understanding Recall：recalled 路径——显示答案 → 自评"良好" → 评分即前进 */
async function recallPass(page: Page, meaning: string) {
  await page.getByRole('button', { name: '显示答案' }).click();
  await expect(page.getByText(meaning, { exact: true })).toBeVisible(); // 揭示态展示 meaning
  await page.getByRole('button', { name: '良好' }).click();
  // 自动前进：等自评按钮消失（冻结瞬态或已切卡）
  await expect(page.getByRole('button', { name: '良好' })).toHaveCount(0);
  // 判语收起 = 已真正切卡（防冻结瞬态重入循环分支）
  await expect(page.getByText('良好', { exact: true })).toBeHidden();
}

/**
 * 驱动会话循环直至完成摘要（主流程骨架，会话型用例共用）。返回是否在步数内完成。
 * 计划：gravity（learn）与 make sense / wear down 走 recall recalled（良好）；
 * stable 走三档自评失败（显示答案→重来，评分即前进，错题可见于今日学习）；raw 填空答对；
 * give up 表达题答对；未知补强卡兜底处理。
 */
async function driveSessionToCompleted(page: Page): Promise<boolean> {
  let stableFailed = false;
  let completed = false;

  for (let step = 0; step < 30 && !completed; step++) {
    await expect(page.getByLabel('填空答案')).toHaveCount(0);
    if (await page.getByRole('heading', { name: '今天完成了' }).isVisible()) {
      completed = true;
      break;
    }

    // 0) 表达卡（give up 原题/撤销替换题，题面不限）：提交包含目标词的句子，通过后手动下一题
    const prodInput = page.getByLabel('表达答案');
    if (await prodInput.isVisible()) {
      await prodInput.fill('The constant stress makes me want to give up.');
      await page.getByRole('button', { name: '提交' }).click();
      await expect(page.getByText('通过', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '下一题' }).click();
      continue;
    }

    // 1) Learn 卡（gravity，Recall Card）：以 source example 识别 → 显示答案 → 良好
    if (await page.getByText('I laugh at gravity all the time.').isVisible()) {
      await expect(page.getByRole('heading', { name: 'gravity' })).toBeVisible();
      await recallPass(page, '重力');
      continue;
    }

    // 3) make sense：Recall recalled 路径（显示答案 → 良好 → 评分即前进）
    if (await page.getByRole('heading', { name: 'make sense' }).isVisible()) {
      await recallPass(page, '讲得通');
      continue;
    }

    // 4) stable：首次出现走三档自评失败（显示答案 → 重来 → 评分即前进）
    //    → fail（错题记录进今日学习），释义/原句在揭示时已看过
    if (!stableFailed && (await page.getByRole('heading', { name: 'stable' }).isVisible())) {
      stableFailed = true;
      await page.getByRole('button', { name: '显示答案' }).click();
      await expect(page.getByText('稳定的', { exact: true })).toBeVisible(); // 揭示态展示 meaning
      await expect(page.getByText('The connection has been stable all week.')).toBeVisible();
      await page.getByRole('button', { name: '重来' }).click();
      // 评分即前进：等自评按钮消失即已切卡
      await expect(page.getByRole('button', { name: '重来' })).toHaveCount(0);
      continue;
    }

    // 5) wear down：Recall recalled 路径
    if (await page.getByRole('heading', { name: 'wear down' }).isVisible()) {
      await recallPass(page, '逐渐消耗');
      continue;
    }

    // 6) 未知补强卡（答错动态插入）：understanding Recall 卡走 recalled；
    //    选择题任选一项，对则继续、错则看解释后手动下一题
    const reveal = page.getByRole('button', { name: '显示答案' });
    if (await reveal.isVisible()) {
      await reveal.click();
      await page.getByRole('button', { name: '良好' }).click();
      continue;
    }
    const optionButtons = page.getByRole('group', { name: '选项' }).getByRole('button');
    if (await optionButtons.first().isVisible()) {
      await optionButtons.first().click();
      const feedback = page.getByText('回答正确');
      const wrong = page.getByText('回答错误');
      await Promise.race([feedback.waitFor({ timeout: 5000 }), wrong.waitFor({ timeout: 5000 })]);
      if (await feedback.isVisible()) {
        await continueAfterCorrect(page);
      } else {
        await page.getByRole('button', { name: '下一题' }).click();
      }
      continue;
    }

    // 卡片切换中（正在加载下一题）：稍等重试
    await page.waitForTimeout(300);
  }

  return completed;
}

test.describe('Today 复习全流程', () => {
  test('正在准备不露答案，失败后稍后再做仍保留总量', async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    await login(page);
    await resetSeedData(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const stopStripping = await stripBoundProduction(page);
    await page.route('**/api/today/tasks/*/prepare', async (route) => {
      if (!first) return route.continue();
      first = false;
      stopStripping();
      await held;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'AI_PROVIDER_ERROR', message: '题目暂时无法生成，请稍后重试' },
        }),
      });
    });
    await page.goto('/today');
    await expect(page).toHaveURL(/\/today$/);
    await expect(page).toHaveTitle('Foxi');
    await page.getByRole('button', { name: '开始今日复习' }).click();
    await expect(page.getByText('正在准备…')).toBeVisible();
    await expect(page.getByLabel('表达答案')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '显示答案' })).toHaveCount(0);
    release();
    await expect(page.getByText('题目暂时无法生成，请稍后重试')).toBeVisible();
    await page.getByRole('button', { name: '稍后再做' }).click();
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();
    await expect(page.getByText('0 / 5', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '显示答案' })).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);
  });
  test('pending → 失败 → 重试 → 可答；稍后保留总量，不出现填空', async ({ page }) => {
    await login(page);
    await resetSeedData(page);
    let prepareCount = 0;
    const stopStripping = await stripBoundProduction(page);
    await page.route('**/api/today/tasks/*/prepare', async (route) => {
      prepareCount += 1;
      if (prepareCount === 1) {
        stopStripping();
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'AI_PROVIDER_ERROR', message: '题目暂时无法生成，请稍后重试' },
          }),
        });
      } else await route.continue();
    });
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();
    await expect(page.getByText('题目暂时无法生成，请稍后重试')).toBeVisible();
    await expect(page.getByLabel('表达答案')).toHaveCount(0);
    await expect(page.getByLabel('填空答案')).toHaveCount(0);
    await expect(page.getByText('0 / 5', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '稍后再做' })).toBeVisible();
    // 准备失败的三个操作在窄屏上也必须完整位于卡片内。
    await page.setViewportSize({ width: 320, height: 480 });
    const pendingCard = (await page.locator('article').boundingBox())!;
    for (const name of ['重试', '稍后再做', '刷新今日学习']) {
      const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(pendingCard.x + pendingCard.width);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByLabel('表达答案')).toBeVisible();
    await expect(page.getByText('give up', { exact: true })).toBeVisible();
    await expect(page.getByText('0 / 5', { exact: true })).toBeVisible();
    await page.screenshot({ path: '/tmp/task7-today-desktop.png' });
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  });
  test('idle → 开始 → Recall（learn/理解 良好、stable 显示答案后重来自评）+ 完整表达 → 完成摘要', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');

    // idle 主卡片：种子 5 个到期（Phase 4 新增 give up 的 P 任务）；new today 为剩余新学额度
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect(
      page.getByText(/^词汇总数 \d+ · 待学 \d+ · 今日到期 4 项 · 可新学 \d+$/),
    ).toBeVisible();
    await page.getByRole('button', { name: '开始今日复习' }).click();

    // active 态：进度行（已完成数/总数，批量 entries 未落地时用会话进度兜底）
    await expect(page.getByText(/^\d+ \/ \d+$/)).toBeVisible();

    const completed = await driveSessionToCompleted(page);

    // 完成摘要：种子 5 个任务 + 可能的补强，断言用 ≥
    expect(completed, '会话应在有限步数内完成').toBe(true);
    await expect(page.getByRole('heading', { name: '今天完成了' })).toBeVisible();
    await expect(page.getByText(/词库剩余 \d+ 词待学 · 共 \d+ 词/)).toBeVisible();
    const summaryText =
      (await page.getByText(/通过 \d+ · 基础通过 \d+ · 未通过 \d+/).textContent()) ?? '';
    const passCount = Number(summaryText.match(/通过 (\d+)/)?.[1] ?? 0);
    expect(passCount).toBeGreaterThanOrEqual(1);

    // 今日学习：按学习项去重分组，stable 组含错题轨迹；展开可只读查看作答记录
    const learning = page.getByRole('list', { name: '今日学习' });
    await expect(learning).toBeVisible();
    const stableGroup = learning.getByRole('button', { name: /stable/ });
    await expect(stableGroup).toContainText('错');
    await stableGroup.click();
    // 分组 li（按钮的父节点）内展开作答记录（fail 可能另插补强题，同组多行）：首行即重来自评。
    // 新契约：U 任务不再后台绑定题目，未通过 recall 的回放只有自评作答（重来），无选择题
    // 正确答案揭示（bound 选择题的揭示路径由 today-navigation/completed-today 组件测试覆盖）
    const stableRecords = stableGroup.locator('..').locator('ul li');
    const recordCount = await stableRecords.count();
    expect(recordCount).toBeGreaterThanOrEqual(1);
    await expect(stableRecords.first()).toContainText('未通过');
    await expect(stableRecords.first()).toContainText('重来');
    await expect(stableRecords.first()).not.toContainText('正确答案');
    // 只读：列表无任何跳转链接
    await expect(learning.getByRole('link')).toHaveCount(0);
  });

  test('同日追加：完成后额度剩余可再学一批', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await resetSeedData(page);

    // Settings 把额度调到 20（默认 10）：主会话只学 gravity 1 个新词 → 完成后剩 19
    await page.goto('/settings');
    await page.getByLabel('每日新学习项上限').selectOption('20');
    await expect(page.getByLabel('每日新学习项上限')).toHaveValue('20'); // 受控值随 PATCH 成功回写

    // 完成整个会话（此时 New Queue 只有 gravity）
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();
    await expect(page.getByText(/^\d+ \/ \d+$/)).toBeVisible();
    expect(await driveSessionToCompleted(page), '会话应在有限步数内完成').toBe(true);
    await expect(page.getByRole('heading', { name: '今天完成了' })).toBeVisible();

    // 播种 extend 待学新词 delta（e2e 专用端点；题目预置库存，AI 生成在 e2e 不可用）
    const seeded = await page.evaluate(async () => {
      const r = await fetch('/api/__e2e/seed-new-item', { method: 'POST', credentials: 'include' });
      return r.status;
    });
    expect(seeded).toBe(200);

    // 回完成摘要：剩余额度 20-1=19 → "再学 19 个新词"
    await page.goto('/today');
    const extendBtn = page.getByRole('button', { name: '再学 19 个新词' });
    await expect(extendBtn).toBeVisible();

    // 点击 extend → invalidate → 回 active 会话，追加的 delta Learn 卡出现（进度总数 +1）
    await extendBtn.click();
    await expect(page.getByRole('heading', { name: 'delta' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('The river delta splits into many channels.')).toBeVisible();
    await expect(page.getByText(/^\d+ \/ \d+$/)).toBeVisible();

    // 做完追加的 delta Learn 卡（Recall 路径：显示答案 → 良好）→ 回完成摘要
    await recallPass(page, '三角洲');
    await expect(page.getByRole('heading', { name: '今天完成了' })).toBeVisible();
  });

  test('今日学习：进度点击打开只读弹层，不影响当前题', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();

    // 首卡是 give up 表达题（会话序 1/6）：提交通过 → 手动下一题，推进到 make sense
    await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();
    await page.getByLabel('表达答案').fill('The constant stress makes me want to give up.');
    await page.getByRole('button', { name: '提交' }).click();
    await expect(page.getByText('通过', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一题' }).click();
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();

    // 进度行显示结果分布（文字计数），点击打开「今日学习」
    await expect(page.getByText(/^通过 \d+ · 基础通过 \d+ · 未通过 \d+$/)).toBeVisible();
    await page.getByRole('button', { name: '查看今日学习' }).click();
    const dialog = page.getByRole('dialog', { name: '今日学习' });
    await expect(dialog).toBeVisible();

    // give up 组：一条通过记录；展开可读题面/作答/正确答案
    const giveUpGroup = dialog.getByRole('button', { name: /give up/ });
    await expect(giveUpGroup).toContainText('对');
    await giveUpGroup.click();
    const giveUpRecord = giveUpGroup.locator('..').locator('ul li');
    await expect(giveUpRecord).toHaveCount(1);
    await expect(giveUpRecord).toContainText('通过');
    await expect(giveUpRecord).toContainText('作答');
    await expect(giveUpRecord).toContainText('正确答案');

    // 未作答条目（stable 等）在分组轨迹中展示"未做"，但只读：无链接、无跳转
    await expect(dialog.getByRole('link')).toHaveCount(0);

    // 关闭后回到原当前题（弹层不改变当前卡）
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();
  });

  test('撤销最近一次作答：立即回同词，造句换题、Recall 不换题；完成页保留入口', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();

    // 首卡 give up 表达题（会话序 1/6）：答对冻结在当前卡，反馈态出现右上撤销图标
    await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();
    await page.getByLabel('表达答案').fill('The constant stress makes me want to give up.');
    await page.getByRole('button', { name: '提交' }).click();
    await expect(page.getByText('通过', { exact: true })).toBeVisible();

    // 确认层写明将撤销的词、题型和结果（PRODUCT §5.1）；取消不发请求、仍留反馈态
    const undoIcon = page.getByRole('button', { name: '撤销最近一次作答' });
    await expect(undoIcon).toBeVisible();
    await undoIcon.click();
    const dialog = page.getByRole('dialog', { name: '撤销最近一次作答' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('give up');
    await expect(dialog).toContainText('表达');
    await expect(dialog).toContainText('通过');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('通过', { exact: true })).toBeVisible();

    // 确认撤销 → 同一个词的新造句题立即重答，旧草稿/反馈清空。
    await undoIcon.click();
    await dialog.getByRole('button', { name: '撤销' }).click();
    await expect(page.getByLabel('表达答案')).toBeVisible();
    await expect(page.getByLabel('表达答案')).toHaveValue('');
    await expect(page.getByText('give up', { exact: true })).toBeVisible();
    await page.getByLabel('表达答案').fill('The constant stress makes me want to give up.');
    await page.getByRole('button', { name: '提交' }).click();
    await expect(page.getByText('通过', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一题' }).click();
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();

    // Recall 评分已自动进入后一个词，撤销也立即回 make sense，复用词卡且未揭示。
    await page.getByRole('button', { name: '显示答案' }).click();
    await page.getByRole('button', { name: '良好' }).click();
    await expect(page.getByRole('heading', { name: 'make sense' })).toHaveCount(0);
    await undoIcon.click();
    await expect(dialog).toContainText('make sense');
    await expect(dialog).toContainText('撤销后立即回到这个词重新作答。');
    await dialog.getByRole('button', { name: '撤销' }).click();
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();
    await expect(page.getByRole('button', { name: '显示答案' })).toBeVisible();
    await expect(page.getByRole('button', { name: '良好' })).toHaveCount(0);

    // 重答后完成整个会话，不遗留队尾重答任务。
    expect(await driveSessionToCompleted(page), '会话应在有限步数内完成').toBe(true);
    await expect(page.getByRole('heading', { name: '今天完成了' })).toBeVisible();
    // 完成页保留最近一次作答的撤销入口（PRODUCT §5.1）
    await expect(page.getByRole('button', { name: '撤销最近一次作答' })).toBeVisible();
  });
});

test.describe('Today V2 全流程（Phase 9 Task 10）', () => {
  interface ReviewStateDto {
    dimension: string;
    stability: number | null;
    nextReviewAt: string | null;
    lastReviewAt: string | null;
  }

  async function libraryStates(
    page: Page,
    ids: string[],
  ): Promise<Record<string, ReviewStateDto[]>> {
    return page.evaluate(async (itemIds: string[]) => {
      const out: Record<
        string,
        {
          dimension: string;
          stability: number | null;
          nextReviewAt: string | null;
          lastReviewAt: string | null;
        }[]
      > = {};
      for (const id of itemIds) {
        const r = await fetch(`/api/library/${id}`, { credentials: 'include' });
        const data = (await r.json()) as {
          reviewStates: {
            dimension: string;
            stability: number | null;
            nextReviewAt: string | null;
            lastReviewAt: string | null;
          }[];
        };
        out[id] = data.reviewStates;
      }
      return out;
    }, ids);
  }

  /**
   * Learn→次日 Production：carry on（chunk）今日 Learn 完成初始化 P（未激活、次日首排）；
   * set off（chunk）为"昨日 Learn 完成、今日造句到期"的次日态，今日会话出现其表达题。
   * e2e 时钟不可跨日，次日态由种子近似（Learn→次日排期数学由 API 单测钉死）。
   */
  test('Learn→次日 Production：chunk Learn 初始化造句、次日表达到期可作答', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await resetSeedData(page);
    const seeded = await page.evaluate(async () => {
      const r = await fetch('/api/__e2e/seed-v2-journeys', {
        method: 'POST',
        credentials: 'include',
      });
      return r.status;
    });
    expect(seeded).toBe(200);

    await page.goto('/today');
    // 到期 5 = 基础 4 + set off 次日到期的 P；put off（显式关闭）与 raw（word 默认关）不计入
    await expect(page.getByText(/今日到期 5 项/)).toBeVisible();
    await page.getByRole('button', { name: '开始今日复习' }).click();
    await expect(page.getByText('0 / 7', { exact: true })).toBeVisible();

    let setOffDone = false;
    let carryOnDone = false;
    let completed = false;
    for (let step = 0; step < 40 && !completed; step++) {
      await expect(page.getByLabel('填空答案')).toHaveCount(0); // V2：任何环节不出新填空
      if (await page.getByRole('heading', { name: '今天完成了' }).isVisible()) {
        completed = true;
        break;
      }
      // 表达卡（give up / set off）：按「必须使用」取目标词作答（fake 批改按 mustUse 判定）
      const prod = page.getByLabel('表达答案');
      if (await prod.isVisible()) {
        const mustUse =
          (await page.getByText(/^必须使用：/).textContent())?.replace('必须使用：', '').trim() ??
          '';
        if (mustUse === 'set off') setOffDone = true;
        await prod.fill(`I want to ${mustUse} now.`);
        await page.getByRole('button', { name: '提交' }).click();
        await expect(page.getByText('通过', { exact: true })).toBeVisible({ timeout: 10_000 });
        await page.getByRole('button', { name: '下一题' }).click();
        continue;
      }
      // Recall 卡（理解复习 / learn 新学）：显示答案 → 良好 → 评分即前进
      const reveal = page.getByRole('button', { name: '显示答案' });
      if (await reveal.isVisible()) {
        if (await page.getByRole('heading', { name: 'carry on' }).isVisible()) carryOnDone = true;
        await reveal.click();
        await page.getByRole('button', { name: '良好' }).click();
        await expect(page.getByRole('button', { name: '良好' })).toHaveCount(0);
        continue;
      }
      await page.waitForTimeout(300);
    }
    expect(completed, '会话应在有限步数内完成').toBe(true);
    await expect(page.getByRole('heading', { name: '今天完成了' })).toBeVisible();
    expect(setOffDone, '次日到期的 set off 表达题应出现并作答').toBe(true);
    expect(carryOnDone, 'carry on 应以 Learn 卡（Recall）完成').toBe(true);

    // 库状态核对（FSRS）：Learn 初始化 P 未激活、次日首排；set off 首答激活 D/S；put off 显式关闭保持原状
    const states = await libraryStates(page, [
      'e2e-item-carry-on',
      'e2e-item-set-off',
      'e2e-item-put-off',
    ]);
    const dim = (id: string, d: string) =>
      states[id]!.find((s) => s.dimension === d) ?? {
        dimension: d,
        stability: -1,
        nextReviewAt: null,
        lastReviewAt: null,
      };
    const carryOnP = dim('e2e-item-carry-on', 'production');
    expect(carryOnP.stability).toBeNull(); // FSRS 未激活（原 L0 语义）
    expect(carryOnP.lastReviewAt).toBeNull();
    expect(carryOnP.nextReviewAt, 'carry on 的 P 应排到明天（Learn 次日首排）').not.toBeNull();
    expect(Date.parse(carryOnP.nextReviewAt!)).toBeGreaterThan(Date.now() + 20 * 3600 * 1000);

    const setOffP = dim('e2e-item-set-off', 'production');
    expect(setOffP.stability, '未激活 P 首答（Good）应激活 FSRS D/S').not.toBeNull();
    expect(setOffP.lastReviewAt).not.toBeNull();
    expect(setOffP.nextReviewAt).not.toBeNull();

    const putOffP = dim('e2e-item-put-off', 'production');
    expect(putOffP.stability).toBe(5); // 显式关闭：被排除且状态不动（种子 S5）
    expect(putOffP.lastReviewAt).not.toBe(setOffP.lastReviewAt);
  });

  test('目标关闭取消当日 P：Library 关闭造句后 Today 队列收敛、当前卡顺延', async ({ page }) => {
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();
    // 首卡 give up 表达题（当日 P 任务，尚未作答）
    await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();
    await expect(page.getByText('0 / 5', { exact: true })).toBeVisible();

    // Library 详情：造句目标 显式开启 → 关闭（三态 override=0）
    await page.goto('/library');
    await page.getByLabel('搜索学习项').fill('give up');
    await page
      .getByRole('link', { name: /give up/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/library\/[a-z0-9-]+$/i);
    await page.getByRole('button', { name: '编辑' }).click();
    const goal = page.getByLabel('造句目标');
    await expect(goal).toHaveValue('enabled'); // 种子 override=1
    await goal.selectOption('disabled');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('button', { name: '编辑' })).toBeVisible();

    // 回 Today：give up 的当日 P 任务被取消，总量 5→4，当前卡顺延为 make sense
    await page.goto('/today');
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();
    await expect(page.getByText('0 / 4', { exact: true })).toBeVisible();
    await expect(page.getByText('长期的压力让我想放弃。')).toHaveCount(0);
    await expect(page.getByLabel('表达答案')).toHaveCount(0);
  });

  test('大队列：44 到期全量 pending，start 不阻塞首屏、进度含未绑定任务', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await resetSeedData(page);
    const seeded = await page.evaluate(async () => {
      const r = await fetch('/api/__e2e/seed-large-queue', {
        method: 'POST',
        credentials: 'include',
      });
      return r.status;
    });
    expect(seeded).toBe(200);

    await page.goto('/today');
    await expect(page.getByText(/今日到期 44 项/)).toBeVisible();
    // start 建全量 pending 队列即返回：不逐题等 AI/库存（旧 V1 行为会分钟级阻塞）
    const startedAt = Date.now();
    await page.getByRole('button', { name: '开始今日复习' }).click();
    await expect(page.getByText('0 / 45', { exact: true })).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    // 首卡 give up 表达题（到期序早于 bulk 批次）；题目绑定走预置库存，不依赖 AI
    await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();
    await page.getByLabel('表达答案').fill('The constant stress makes me want to give up.');
    await page.getByRole('button', { name: '提交' }).click();
    await expect(page.getByText('通过', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一题' }).click();
    // 懒绑定逐题进行：次卡（make sense Recall）仍即时出现，进度推进且无填空
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('1 / 45', { exact: true })).toBeVisible();
    await expect(page.getByLabel('填空答案')).toHaveCount(0);
  });
});

test.describe('Today 沉浸式卡（移动端，PRODUCT §5.1 一题一屏）', () => {
  // 375x480 模拟短屏 + 键盘弹出后的可视高度：输入与主操作必须仍可达
  test.use({ viewport: { width: 375, height: 480 } });

  test('窄屏长目标词换行，正文不产生横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 480 });
    await login(page);
    await resetSeedData(page);
    const longTarget = 'pneumonoultramicroscopicsilicovolcanoconiosis';
    await page.route('**/api/today', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      if (data.currentTask?.question?.mustUse) {
        data.currentTask.item.target = longTarget;
        data.currentTask.question.mustUse = longTarget;
      }
      await route.fulfill({ response, json: data });
    });
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();
    await expect(page.getByText(longTarget, { exact: true })).toBeVisible();
    const body = page.locator('[data-slot="body"]');
    expect(await body.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
      await body.evaluate((element) => element.clientWidth),
    );
    await expect(page.getByLabel('表达答案')).toBeVisible();
  });

  test('短屏：卡填满顶栏/导航之间，输入与主操作停靠其上；主动不会揭示参考句', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();

    // 首卡为 give up 表达题（会话序第 1）
    await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();

    const card = page.locator('article').first();
    const nav = page.locator('nav.fixed');
    const cardBox = (await card.boundingBox())!;
    const navBox = (await nav.boundingBox())!;
    expect(cardBox, '卡面应有占位高度').not.toBeNull();
    // 卡填满顶栏与底部导航之间的可用高度，且不被导航覆盖
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(navBox.y + 2);
    expect(navBox.y - (cardBox.y + cardBox.height)).toBeLessThanOrEqual(2);

    // 输入框与提交按钮完整落在视口内、导航之上（键盘弹出同理：停靠底部）
    const inputBox = (await page.getByLabel('表达答案').boundingBox())!;
    const submitBox = (await page.getByRole('button', { name: '提交' }).boundingBox())!;
    expect(inputBox.y).toBeLessThan(submitBox.y);
    expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(navBox.y + 1);
    expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(480);

    // 主动不会：参考句/用法揭示、无纠错 diff，手动下一题
    await page.getByRole('button', { name: '不会表达' }).click();
    await expect(page.getByText('主动不会')).toBeVisible();
    await expect(page.getByText('The constant stress makes me want to give up.')).toBeVisible();
    await expect(page.getByText('允许正常时态和人称变化。')).toBeVisible();
    await expect(page.getByText('纠正后')).toHaveCount(0);
    await page.screenshot({ path: '/tmp/task7-today-mobile.png' });
    await page.getByRole('button', { name: '下一题' }).click();
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();
  });

  // 键盘几何用真机高度（375x812）：模拟 visualViewport 收缩到 552px，
  // 验证顶部保持原位、卡底 dock 对齐可视区底部，导航不浮到键盘上方。
  test.describe('键盘避让（iPhone 高度）', () => {
    test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

    test('造句输入一行起步、逐行增长封顶、删除缩回，键盘期间题干与目标词可见', async ({ page }) => {
      await login(page);
      await resetSeedData(page);
      await page.goto('/today');
      await page.getByRole('button', { name: '开始今日复习' }).click();
      const input = page.getByLabel('表达答案');
      const oneLineHeight = (await input.boundingBox())!.height;
      expect(oneLineHeight).toBeLessThanOrEqual(46);
      await input.tap();
      await page.evaluate(() => {
        const vv = window.visualViewport!;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => 389 });
        vv.dispatchEvent(new Event('resize'));
      });
      await expect(input).toBeFocused();
      let previousHeight = oneLineHeight;
      for (let lines = 2; lines <= 4; lines++) {
        await input.fill(Array.from({ length: lines }, () => 'I will not give up.').join('\n'));
        const height = (await input.boundingBox())!.height;
        expect(height).toBeGreaterThan(previousHeight);
        previousHeight = height;
      }
      await input.fill(Array.from({ length: 8 }, () => 'I will not give up.').join('\n'));
      expect((await input.boundingBox())!.height).toBeCloseTo(previousHeight, 0);
      expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      for (const text of ['长期的压力让我想放弃。', 'give up']) {
        const box = (await page.getByText(text, { exact: true }).boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(54);
        expect(box.y + box.height).toBeLessThan((await input.boundingBox())!.y);
      }
      await expect(page.getByRole('button', { name: '提交' })).toBeVisible();
      expect(
        await page.locator('[data-slot="body"]').evaluate((el) => el.clientHeight),
      ).toBeGreaterThanOrEqual(48);
      await page.screenshot({ path: '/tmp/foxi-compact-four-lines.png' });
      await input.fill('I will not give up.');
      expect((await input.boundingBox())!.height).toBeCloseTo(oneLineHeight, 0);
      await input.fill('I will not give up, even when things get difficult. '.repeat(3));
      expect((await input.boundingBox())!.height).toBeGreaterThan(oneLineHeight);
      await input.fill('I will not give up.');
      await page.screenshot({ path: '/tmp/foxi-compact-one-line.png' });
      await page.evaluate(() => {
        const vv = window.visualViewport!;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => 552 });
        vv.dispatchEvent(new Event('resize'));
      });
      const expandedCard = (await page.locator('article').first().boundingBox())!;
      expect(expandedCard.y + expandedCard.height).toBeCloseTo(552, 0);
    });

    test('长中文题干在更小键盘视口里滚动，目标词和提交仍可见', async ({ page }) => {
      await login(page);
      await resetSeedData(page);
      const rewrite = async (route: Route) => {
        const response = await route.fetch();
        const data = await response.json();
        if (data.currentTask?.question?.zhPrompt) {
          data.currentTask.question.zhPrompt =
            '即使遇到困难，我也想继续坚持下去，而不是轻易放弃。'.repeat(8);
        }
        await route.fulfill({ response, json: data });
      };
      await page.route('**/api/today', rewrite);
      await page.route('**/api/today/start', rewrite);
      await page.goto('/today');
      await page.getByRole('button', { name: '开始今日复习' }).click();
      const input = page.getByLabel('表达答案');
      await input.tap();
      await page.evaluate(() => {
        const vv = window.visualViewport!;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => 320 });
        vv.dispatchEvent(new Event('resize'));
      });
      await input.fill('I will keep trying and will not give up.\n'.repeat(8));
      const prompt = page.locator('.production-prompt-scroll');
      expect(await prompt.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      const promptBox = (await prompt.boundingBox())!;
      const targetBox = (await page.getByText('give up', { exact: true }).boundingBox())!;
      const inputBox = (await input.boundingBox())!;
      const submitBox = (await page.getByRole('button', { name: '提交' }).boundingBox())!;
      expect(promptBox.height).toBeGreaterThanOrEqual(48);
      expect(targetBox.y).toBeGreaterThanOrEqual(promptBox.y + promptBox.height);
      expect(targetBox.y + targetBox.height).toBeLessThanOrEqual(inputBox.y);
      expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(320);
      await prompt.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      expect((await page.getByText('give up', { exact: true }).boundingBox())!.y).toBe(targetBox.y);
      await page.screenshot({ path: '/tmp/foxi-compact-long-prompt.png' });
    });

    test('主屏应用内五击 Foxi 切换视口与卡片诊断面板', async ({ page }) => {
      await login(page);
      await resetSeedData(page);
      await page.goto('/today');
      await page.getByRole('button', { name: '开始今日复习' }).click();
      for (let index = 0; index < 5; index++)
        await page.getByRole('button', { name: 'Foxi' }).click();
      await expect(page.locator('[data-kb-debug]')).toContainText('vv.height');
      await expect(page.locator('[data-kb-debug]')).toContainText('card');
      await page.screenshot({ path: '/tmp/foxi-kbdebug-local.png' });
      for (let index = 0; index < 5; index++)
        await page.getByRole('button', { name: 'Foxi' }).click();
      await expect(page.locator('[data-kb-debug]')).toHaveCount(0);
    });

    test('键盘避让：视觉视口缩小时顶栏不动、输入停靠键盘线上、导航隐藏', async ({ page }) => {
      test.setTimeout(90_000);
      const runtimeErrors: string[] = [];
      page.on('pageerror', (error) => runtimeErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') runtimeErrors.push(message.text());
      });
      await login(page);
      await resetSeedData(page);
      await page.goto('/today');
      await expect(page).toHaveTitle('Foxi');
      await page.getByRole('button', { name: '开始今日复习' }).click();
      await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();

      const card = page.locator('article').first();
      const nav = page.locator('nav.fixed');
      const header = page.locator('header.fixed');
      const shell = page.locator('#root > div');
      const cardBefore = (await card.boundingBox())!;
      const headerBefore = (await header.boundingBox())!;
      const inputBefore = (await page.getByLabel('表达答案').boundingBox())!;
      const shellPositionBefore = await shell.evaluate(
        (element) => getComputedStyle(element).position,
      );
      expect(await shell.evaluate((element) => getComputedStyle(element).transform)).toBe('none');

      await page.evaluate(() => {
        document.addEventListener(
          'click',
          (event) => {
            const target = event.target as HTMLElement;
            document.documentElement.dataset.lastTodayClick =
              target.getAttribute('aria-label') ?? target.tagName;
          },
          { capture: true, once: true },
        );
        // 模拟 iOS 在同一次触摸的 pointerdown 与 click 之间开始缩小视口。
        document.addEventListener(
          'pointerdown',
          (event) => {
            const target = event.target as HTMLElement;
            if (target.getAttribute('aria-label') !== '表达答案') return;
            const vv = window.visualViewport!;
            Object.defineProperty(vv, 'height', { configurable: true, get: () => 389 });
            vv.dispatchEvent(new Event('resize'));
            document.documentElement.dataset.touchPending = String(
              document.documentElement.hasAttribute('data-today-touch-pending'),
            );
            document.documentElement.dataset.touchInputTop = String(
              target.getBoundingClientRect().top,
            );
          },
          { once: true },
        );
      });
      await page.getByLabel('表达答案').tap();
      expect(await page.locator('html').getAttribute('data-last-today-click')).toBe('表达答案');
      expect(await page.locator('html').getAttribute('data-touch-pending')).toBe('true');
      expect(
        Math.abs(
          Number(await page.locator('html').getAttribute('data-touch-input-top')) - inputBefore.y,
        ),
      ).toBeLessThanOrEqual(1);
      await expect(page.getByLabel('表达答案')).toBeFocused();
      await page.waitForTimeout(400);
      await expect(page.getByLabel('表达答案')).toBeFocused();
      await page.keyboard.type('test');
      await expect(page.getByLabel('表达答案')).toHaveValue('test');
      await expect(page.locator('html[data-today-keyboard-primed]')).toHaveCount(1);
      const primedCard = (await card.boundingBox())!;
      expect(primedCard.y).toBeLessThan(cardBefore.y); // 进度合并顶栏，题卡获得更多空间
      expect(primedCard.y + primedCard.height).toBeLessThanOrEqual(812 * 0.48 + 2);

      for (const height of [780, 750, 715, 690, 620, 552]) {
        await page.evaluate((nextHeight) => {
          const vv = window.visualViewport;
          if (!vv) throw new Error('visualViewport unavailable');
          Object.defineProperty(vv, 'height', { configurable: true, get: () => nextHeight });
          vv.dispatchEvent(new Event('resize'));
        }, height);
        const frameHeader = (await header.boundingBox())!;
        const frameCard = (await card.boundingBox())!;
        expect(frameHeader.y).toBe(headerBefore.y);
        expect(frameCard.y).toBe(primedCard.y);
        expect(frameCard.y + frameCard.height).toBeLessThanOrEqual(
          Math.min(cardBefore.y + cardBefore.height, height) + 1,
        );
      }
      expect(await shell.evaluate((element) => getComputedStyle(element).position)).toBe(
        shellPositionBefore,
      ); // 聚焦不能让整个页面从普通布局切到 fixed
      await expect(page.locator('[data-keyboard-open]')).toHaveCount(1);

      // iOS PWA 的 offsetTop 可能在 resize/scroll 中先报 0、后报真实值；
      // 任何时刻都不能再据此平移整页，否则顶栏会在两个数值之间闪动。
      await page.evaluate(() => {
        const vv = window.visualViewport!;
        Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 423 });
        vv.dispatchEvent(new Event('scroll'));
      });
      expect(await shell.evaluate((element) => getComputedStyle(element).transform)).toBe('none');

      const cardAfter = (await card.boundingBox())!;
      const headerAfter = (await header.boundingBox())!;
      expect(headerAfter.y).toBe(headerBefore.y); // 顶栏不动
      expect(cardAfter.y).toBe(primedCard.y); // 紧凑布局切换后，动画期间卡顶不动
      expect(cardAfter.height).toBeLessThan(cardBefore.height); // 卡身压缩
      expect(cardAfter.y + cardAfter.height).toBeLessThanOrEqual(552); // 卡底不压键盘
      const inputBox = (await page.getByLabel('表达答案').boundingBox())!;
      expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(552); // 输入框在键盘线上
      await expect(nav).toBeHidden();

      // 输入法自带下箭头只隐藏键盘，输入仍聚焦：不能靠手动 blur 掩盖收起 bug。
      await expect(page.getByLabel('表达答案')).toBeFocused();
      await page.evaluate(() => {
        // 系统收起路径可能留下 document 的 reveal 滚动；恢复后必须清理，
        // 否则下一次聚焦继承旧原点，整页被推走且卡底与键盘间出现空隙。
        document.body.style.minHeight = '2000px';
        window.scrollTo(0, 107);
        const vv = window.visualViewport!;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => 812 });
        Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
        vv.dispatchEvent(new Event('resize'));
      });
      await expect(page.locator('html[data-today-keyboard-primed]')).toHaveCount(0);
      await expect(nav).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      const restoredCard = (await card.boundingBox())!;
      expect(restoredCard.y).toBe(cardBefore.y);
      expect(restoredCard.height).toBeCloseTo(cardBefore.height, 0);
      await expect(page.getByLabel('表达答案')).not.toBeFocused();
      await expect(page.getByLabel('表达答案')).toHaveValue('test');
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
      await page.screenshot({ path: '/tmp/foxi-keyboard-restored.png' });

      // 系统先恢复焦点但键盘尚未出现时，也不能跳过 pointerdown→click 保护。
      await page.evaluate(() => window.scrollTo(0, 107)); // 模拟收起结束后迟到的 reveal 滚动
      await page.getByLabel('表达答案').evaluate((element) => (element as HTMLElement).focus());
      await page.evaluate(() => {
        document.addEventListener(
          'pointerdown',
          (event) => {
            const target = event.target as HTMLElement;
            if (target.getAttribute('aria-label') !== '表达答案') return;
            document.documentElement.dataset.secondTouchPending = String(
              document.documentElement.hasAttribute('data-today-touch-pending'),
            );
            const vv = window.visualViewport!;
            Object.defineProperty(vv, 'height', { configurable: true, get: () => 389 });
            vv.dispatchEvent(new Event('resize'));
          },
          { once: true },
        );
      });
      await page.getByLabel('表达答案').tap();
      expect(await page.locator('html').getAttribute('data-second-touch-pending')).toBe('true');
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page.getByLabel('表达答案')).toBeFocused();
      await page.evaluate(() => {
        const vv = window.visualViewport!;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => 389 });
        vv.dispatchEvent(new Event('resize'));
      });
      await page.keyboard.type(' again');
      await expect(page.getByLabel('表达答案')).toHaveValue('test again');
      expect((await header.boundingBox())!.y).toBe(headerBefore.y);
      const reopenedCard = (await card.boundingBox())!;
      expect(reopenedCard.y + reopenedCard.height).toBeCloseTo(389, 0);
      await page.screenshot({ path: '/tmp/foxi-keyboard-reopened.png' });
      // 多轮通过输入法按钮收起并重开，卡底不能累积额外空隙。
      for (let cycle = 0; cycle < 2; cycle++) {
        await page.evaluate(() => {
          window.scrollTo(0, 107);
          const vv = window.visualViewport!;
          Object.defineProperty(vv, 'height', { configurable: true, get: () => 812 });
          vv.dispatchEvent(new Event('resize'));
        });
        await expect(nav).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        await page.getByLabel('表达答案').tap();
        await page.evaluate(() => {
          const vv = window.visualViewport!;
          Object.defineProperty(vv, 'height', { configurable: true, get: () => 389 });
          vv.dispatchEvent(new Event('resize'));
        });
        await expect(page.getByLabel('表达答案')).toBeFocused();
        expect((await header.boundingBox())!.y).toBe(headerBefore.y);
        const repeatCard = (await card.boundingBox())!;
        expect(repeatCard.y + repeatCard.height).toBeCloseTo(389, 0);
        await expect(page.getByLabel('表达答案')).toHaveValue('test again');
      }
      // 其他方式先 blur 再收键盘，沿用原来的等待动画路径。
      await page.getByLabel('表达答案').evaluate((element) => (element as HTMLElement).blur());
      await expect(nav).toBeHidden();
      await page.evaluate(() => {
        const vv = window.visualViewport!;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => 812 });
        vv.dispatchEvent(new Event('resize'));
      });
      await expect(nav).toBeVisible();
      expect((await card.boundingBox())!.height).toBeCloseTo(cardBefore.height, 0);

      // 普通页面滚动不是 iOS 键盘平移：失焦后不可把 fixed 顶栏再往下推。
      await page.evaluate(() => {
        document.body.style.minHeight = '2000px';
        window.scrollTo(0, 107);
      });
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(107);
      expect((await header.boundingBox())!.y).toBe(headerBefore.y);
      expect(runtimeErrors).toEqual([]);
    });
  });
});
