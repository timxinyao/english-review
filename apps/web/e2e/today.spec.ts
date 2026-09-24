import { expect, test, type Page } from '@playwright/test';

/**
 * Today 复习全流程（PC viewport；E2E_SEED=1 播种：
 * 4 个到期任务 stable/wear down/raw/make sense + 1 个 New Queue 项 gravity）
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

/** 答对后：点击任意处立即继续；若 2 秒自动下一题已先行触发则忽略 */
async function continueAfterCorrect(page: Page) {
  const feedback = page.getByText('回答正确');
  await expect(feedback).toBeVisible({ timeout: 5000 });
  try {
    await feedback.click({ timeout: 1200 });
  } catch {
    // 自动下一题已触发，无需点击
  }
}

test.describe('Today 复习全流程', () => {
  test('idle → 开始 → Learn + 选择/填空/稍后/答错 → 完成摘要', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');

    // idle 主卡片：种子 5 个到期（Phase 4 新增 give up 的 P 任务）；new today 为剩余新学额度
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect(page.getByText(/^5 items due · \d+ new today$/)).toBeVisible();
    await page.getByRole('button', { name: '开始今日复习' }).click();

    // active 态：细进度行
    await expect(page.getByText(/^\d+ \/ \d+$/)).toBeVisible();

    // 计划：gravity 学对；stable 答错一次看解释；wear down 稍后一次回来再答对；
    // make sense 答对走自动下一题；raw 填空答对；give up 表达题答对（Phase 4 种子）；未知补强卡兜底处理。
    let stableFailed = false;
    let wearDownDeferred = false;
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

      // 1) Learn 卡（gravity）：以 source example 识别，答对首道选择题
      if (await page.getByText('I laugh at gravity all the time.').isVisible()) {
        await expect(page.getByRole('heading', { name: 'gravity' })).toBeVisible();
        await page.getByRole('button', { name: '重力' }).click();
        await continueAfterCorrect(page);
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

      // 3) stable：第一次出现时故意答错，看到正确答案与解释
      if (!stableFailed && (await page.getByRole('button', { name: '稳定的' }).isVisible())) {
        stableFailed = true;
        await page
          .getByRole('group', { name: '选项' })
          .getByRole('button')
          .filter({ hasNotText: '稳定的' })
          .first()
          .click();
        await expect(page.getByText('回答错误')).toBeVisible();
        await expect(page.getByText('正确答案：', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '下一题' }).click();
        continue;
      }

      // 4) wear down：第一次稍后再做；队列后部回来时答对
      if (await page.getByRole('button', { name: '逐渐消耗' }).isVisible()) {
        if (!wearDownDeferred) {
          wearDownDeferred = true;
          await page.getByRole('button', { name: '稍后再做' }).click();
          // 等 later 落库、切换到下一张卡，避免紧接着把同一张卡答掉（与 later 竞态）
          await expect(page.getByRole('button', { name: '逐渐消耗' })).toBeHidden({
            timeout: 5000,
          });
        } else {
          await page.getByRole('button', { name: '逐渐消耗' }).click();
          await continueAfterCorrect(page);
        }
        continue;
      }

      // 5) make sense：答对，走自动下一题/点击继续
      if (await page.getByRole('button', { name: '讲得通' }).isVisible()) {
        await page.getByRole('button', { name: '讲得通' }).click();
        await continueAfterCorrect(page);
        continue;
      }

      // 6) 未知补强卡（答错动态插入）：任选一项；对则继续、错则看解释后手动下一题
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

    // 完成摘要：种子 5 个任务 + 可能的补强，断言用 ≥
    expect(completed, '会话应在有限步数内完成').toBe(true);
    await expect(page.getByRole('heading', { name: '今天完成了' })).toBeVisible();
    const summaryText = (await page.getByText(/^共完成 \d+ 个任务/).textContent()) ?? '';
    const doneCount = Number(summaryText.match(/\d+/)?.[0] ?? 0);
    expect(doneCount).toBeGreaterThanOrEqual(5);
    await expect(page.getByText(/通过 \d+ · 基础通过 \d+ · 未通过 \d+/)).toBeVisible();
    await expect(page.getByText(/新学 \d+ 项/)).toBeVisible();
  });
});
