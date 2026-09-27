import { expect, test, type Page } from '@playwright/test';

/**
 * Today 复习全流程（PC viewport；E2E_SEED=1 播种：
 * 5 个到期任务（give up/make sense/raw/stable/wear down）+ 1 个 New Queue 项 gravity）。
 * start 后会话为固定序（到期按 next_review_at+item.id，New Queue learn 殿后，混排不改变）：
 * give up 表达 → make sense 理解 → raw 填空 → stable 理解 → wear down 理解 → gravity learn
 * understanding 与 learn 卡均为 Recall Card（PRODUCT §7.1"新词初见即回忆"）：主流程覆盖——
 * gravity（learn）与 make sense/wear down 走 recalled（显示答案→想起来了）、stable 走 hint 选错
 * （给我提示→选错误项→冻结"没想起来"+正确释义/原句揭示）；assisted（提示后想起）由组件单测覆盖。
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

/** understanding Recall：recalled 路径——显示答案 → 自评"想起来了" → 冻结反馈 → 下一题 */
async function recallPass(page: Page, meaning: string) {
  await page.getByRole('button', { name: '显示答案' }).click();
  await expect(page.getByText(meaning, { exact: true })).toBeVisible(); // 揭示态展示 meaning
  await page.getByRole('button', { name: '想起来了' }).click();
  // 冻结：自评按钮消失，RecallFeedback 文案"想起来了"出现
  await expect(page.getByRole('button', { name: '想起来了' })).toHaveCount(0);
  await expect(page.getByText('想起来了', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一题' }).click();
}

/**
 * 驱动会话循环直至完成摘要（主流程骨架，会话型用例共用）。返回是否在步数内完成。
 * 计划：gravity（learn）与 make sense / wear down 走 recall recalled（想起来了）；
 * stable 走 hint 选错（没想起来，错题进回顾列表首位）；raw 填空答对；
 * give up 表达题答对；未知补强卡兜底处理。
 */
async function driveSessionToCompleted(page: Page): Promise<boolean> {
  let stableFailed = false;
  let completed = false;

  for (let step = 0; step < 30 && !completed; step++) {
    if (await page.getByRole('heading', { name: '今天完成了' }).isVisible()) {
      completed = true;
      break;
    }

    // 0) 表达卡（give up，Phase 4 种子）：提交包含目标词的句子，通过后手动下一题
    if (await page.getByText('长期的压力让我想放弃。').isVisible()) {
      await page.getByLabel('表达答案').fill('The constant stress makes me want to give up.');
      await page.getByRole('button', { name: '提交' }).click();
      await expect(page.getByText('通过', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '下一题' }).click();
      continue;
    }

    // 1) Learn 卡（gravity，Recall Card）：以 source example 识别 → 显示答案 → 想起来了
    if (await page.getByText('I laugh at gravity all the time.').isVisible()) {
      await expect(page.getByRole('heading', { name: 'gravity' })).toBeVisible();
      await recallPass(page, '重力');
      continue;
    }

    // 2) 填空卡（raw）：输入答案提交，正确后手动下一题
    const blank = page.getByLabel('填空答案');
    if (await blank.isVisible()) {
      await blank.fill('raw');
      await page.getByRole('button', { name: '提交' }).click();
      await expect(page.getByText('回答正确')).toBeVisible();
      await page.getByRole('button', { name: '下一题' }).click();
      continue;
    }

    // 3) make sense：Recall recalled 路径（显示答案 → 想起来了 → 冻结"想起来了"）
    if (await page.getByRole('heading', { name: 'make sense' }).isVisible()) {
      await recallPass(page, '讲得通');
      continue;
    }

    // 4) stable：首次出现走 Hint 选错（给我提示 → 选错误项）
    //    → 冻结"没想起来" + 正确释义与原句揭示（fail，进回顾列表首位）
    if (!stableFailed && (await page.getByRole('heading', { name: 'stable' }).isVisible())) {
      stableFailed = true;
      await page.getByRole('button', { name: '给我提示' }).click();
      await expect(page.getByText('stable 在这里最接近什么意思？')).toBeVisible();
      await page
        .getByRole('group', { name: '选项' })
        .getByRole('button')
        .filter({ hasNotText: '稳定的' })
        .first()
        .click();
      await expect(page.getByText('没想起来', { exact: true })).toBeVisible();
      await expect(page.getByText('正确释义：', { exact: true })).toBeVisible();
      await expect(page.getByText('稳定的', { exact: true })).toBeVisible();
      await expect(page.getByText('原句', { exact: true })).toBeVisible();
      await expect(page.getByText('The connection has been stable all week.')).toBeVisible();
      await page.getByRole('button', { name: '下一题' }).click();
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
      await page.getByRole('button', { name: '想起来了' }).click();
      await page.getByRole('button', { name: '下一题' }).click();
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
  test('idle → 开始 → Recall（learn/理解 想起来了、提示选错）+ 填空/表达 → 完成摘要', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');

    // idle 主卡片：种子 5 个到期（Phase 4 新增 give up 的 P 任务）；new today 为剩余新学额度
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect(page.getByText(/^词汇总数 \d+ · 待学 \d+ · 今日到期 5 项 · 可新学 \d+$/)).toBeVisible();
    await page.getByRole('button', { name: '开始今日复习' }).click();

    // active 态：细进度行（批量 entries 未落地时为 "0 / 6"，落地后为 "第 1 / 6"）
    await expect(page.getByText(/^(第 )?\d+ \/ \d+$/)).toBeVisible();

    const completed = await driveSessionToCompleted(page);

    // 完成摘要：种子 5 个任务 + 可能的补强，断言用 ≥
    expect(completed, '会话应在有限步数内完成').toBe(true);
    await expect(page.getByRole('heading', { name: '今天完成了' })).toBeVisible();
    await expect(page.getByText(/词库剩余 \d+ 词待学 · 共 \d+ 词/)).toBeVisible();
    const summaryText =
      (await page.getByText(/通过 \d+ · 基础通过 \d+ · 未通过 \d+/).textContent()) ?? '';
    const passCount = Number(summaryText.match(/通过 (\d+)/)?.[1] ?? 0);
    expect(passCount).toBeGreaterThanOrEqual(1);

    // 今日回顾列表：错题在前，含 Hint 选错的 stable
    const reviewList = page.getByRole('list', { name: '今日回顾' });
    await expect(reviewList).toBeVisible();
    const firstRow = reviewList.getByRole('listitem').first();
    await expect(firstRow).toContainText('错');
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
    await expect(page.getByText(/^(第 )?\d+ \/ \d+$/)).toBeVisible();
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
    await expect(page.getByText(/^第 \d+ \/ \d+$/)).toBeVisible();

    // 做完追加的 delta Learn 卡（Recall 路径：显示答案 → 想起来了）→ 回完成摘要
    await recallPass(page, '三角洲');
    await expect(page.getByRole('heading', { name: '今天完成了' })).toBeVisible();
  });

  test('导航：列表回看与未做条目置灰', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();

    // 首卡是 give up 表达题（会话序第 1/6）：提交通过 → 手动下一题，推进到第 2/6（make sense）
    await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();
    await page.getByLabel('表达答案').fill('The constant stress makes me want to give up.');
    await page.getByRole('button', { name: '提交' }).click();
    await expect(page.getByText('通过', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一题' }).click();

    // make sense（当前卡）：Recall recalled 路径（显示答案 → 想起来了）
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();
    await recallPass(page, '讲得通');

    // 打开列表：全量任务；点已完成的 give up 回看（只读）
    await page.getByRole('button', { name: '查看任务列表' }).click();
    const dialog = page.getByRole('dialog', { name: '任务列表' });
    await expect(dialog).toBeVisible();
    const giveUpEntry = dialog.getByRole('button', { name: /give up/ });
    // 等批量 entries 拿到该题结果（invalidate refetch 落地），否则点进去是可作答视图而非回看
    await expect(giveUpEntry).toContainText('对');
    await giveUpEntry.click();
    await expect(page.getByText(/^第 1 \/ \d+$/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'give up' })).toBeVisible();
    // 回看态：返回当前按钮已移除（回当前=列表点当前项，语义由单测覆盖）
    await expect(page.getByRole('button', { name: '返回当前' })).toHaveCount(0);

    // 未做条目（stable，非当前）置灰不可点
    await page.getByRole('button', { name: '查看任务列表' }).click();
    const stableEntry = dialog.getByRole('button', { name: /stable/ });
    await expect(stableEntry).toBeDisabled();
    await stableEntry.click({ force: true });
    await expect(page.getByText(/^第 1 \/ \d+$/)).toBeVisible(); // 仍停留回看位
  });
});
