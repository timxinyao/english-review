import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4 表达题与练一下（PC viewport；E2E_SEED=1 播种：
 * Phase 3 的 4 到期 + gravity Learn 之外，新增 give up（P-L4 表达题）：
 * zhPrompt “长期的压力让我想放弃。”、mustUse "give up"；
 * fake 批改：答案包含 "give up" → pass（corrected=原句、eligible 入个人例句），否则 fail。）
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

test.describe('Phase 4：表达题批改与 Library 练一下', () => {
  test('Today 表达题：中文提示 → 提交 → 通过 + diff + 已存个人例句 → 手动下一题', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');

    // idle 主卡片：种子 5 到期（含 give up）+ 新学额度
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await page.getByRole('button', { name: '开始今日复习' }).click();
    await expect(page.getByText(/^\d+ \/ \d+$/)).toBeVisible();

    let productionDone = false;
    let completed = false;
    for (let step = 0; step < 40 && !completed; step++) {
      if (await page.getByRole('heading', { name: '今天完成了' }).isVisible()) {
        completed = true;
        break;
      }

      // 1) 表达题卡（give up）
      if (await page.getByText('长期的压力让我想放弃。').isVisible()) {
        productionDone = true;
        await expect(page.getByText('必须使用：give up')).toBeVisible();
        await page.getByLabel('表达答案').fill('The constant stress makes me want to give up.');
        await page.getByRole('button', { name: '提交' }).click();
        await expect(page.getByText('通过', { exact: true })).toBeVisible();
        // pass 时 corrected = 原句（diff 全 same）
        await expect(page.getByText('The constant stress makes me want to give up.')).toBeVisible();
        await expect(page.getByText('已存入个人例句')).toBeVisible();
        // 表达题手动下一题
        await page.getByRole('button', { name: '下一题' }).click();
        continue;
      }

      // 2) Learn 卡（gravity）
      if (await page.getByText('I laugh at gravity all the time.').isVisible()) {
        await page.getByRole('button', { name: '重力' }).click();
        await continueAfterCorrect(page);
        continue;
      }

      // 3) 填空卡（raw）
      const blank = page.getByLabel('填空答案');
      if (await blank.isVisible()) {
        await blank.fill('raw');
        await page.getByRole('button', { name: '提交' }).click();
        await expect(page.getByText('回答正确')).toBeVisible();
        await page.getByRole('button', { name: '下一题' }).click();
        continue;
      }

      // 4) 已知选择题（stable / wear down / make sense）：直接答对
      let knownAnswered = false;
      for (const correct of ['稳定的', '逐渐消耗', '讲得通']) {
        if (!knownAnswered && (await page.getByRole('button', { name: correct }).isVisible())) {
          knownAnswered = true;
          await page.getByRole('button', { name: correct }).click();
          await continueAfterCorrect(page);
        }
      }
      if (knownAnswered) continue;

      // 5) 未知补强卡：任选一项，对错都收尾后继续
      const optionButtons = page.getByRole('group', { name: '选项' }).getByRole('button');
      if (await optionButtons.first().isVisible()) {
        await optionButtons.first().click();
        await Promise.race([
          page.getByText('回答正确').waitFor({ timeout: 5000 }),
          page.getByText('回答错误').waitFor({ timeout: 5000 }),
        ]);
        if (await page.getByText('回答正确').isVisible()) {
          await continueAfterCorrect(page);
        } else {
          await page.getByRole('button', { name: '下一题' }).click();
        }
        continue;
      }

      // 卡片切换中：稍等重试
      await page.waitForTimeout(300);
    }

    expect(productionDone, '应出现并完成 give up 表达题').toBe(true);
    expect(completed, '会话应在有限步数内完成').toBe(true);
  });

  test('Library 详情：造句历史 1 条（corrected）与个人例句 1 条（未固定）', async ({ page }) => {
    await login(page);
    await page.goto('/library');

    await page.getByLabel('搜索学习项').fill('give up');
    const row = page.getByRole('link', { name: /give up/ }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(/\/library\/[a-z0-9-]+$/i);

    // 造句历史区块恰好 1 条，corrected 为答句
    const historyItems = page.locator('section[aria-label="造句历史"] li');
    await expect(historyItems).toHaveCount(1);
    await expect(
      historyItems.getByText('The constant stress makes me want to give up.'),
    ).toBeVisible();

    // 个人例句 1 条且未固定（未固定展示“收藏”，固定后为“取消收藏”）
    await expect(
      page.getByText('The constant stress makes me want to give up.', { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '收藏', exact: true })).toBeVisible();
  });

  test('Library 练一下：进入练习 → 答题（表达题通过 + diff）→ 完成返回详情', async ({ page }) => {
    await login(page);
    await page.goto('/library');

    await page.getByLabel('搜索学习项').fill('give up');
    await page
      .getByRole('link', { name: /give up/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/library\/[a-z0-9-]+$/i);

    await page.getByRole('button', { name: '练一下' }).click();
    // 练习视图：顶部小进度 1 / 3
    await expect(page.getByText(/^\d+ \/ 3$/)).toBeVisible();

    let done = false;
    for (let step = 0; step < 12 && !done; step++) {
      if (await page.getByText('练习完成').isVisible()) {
        done = true;
        break;
      }

      // 表达题：答包含 give up 的句子 → 通过 + diff
      const textarea = page.getByLabel('表达答案');
      if (await textarea.isVisible()) {
        await textarea.fill('He decided to give up smoking.');
        await page.getByRole('button', { name: '提交' }).click();
        await expect(page.getByText('通过', { exact: true })).toBeVisible();
        await expect(page.getByText('He decided to give up smoking.').first()).toBeVisible();
        await page.getByRole('button', { name: '下一题' }).click();
        continue;
      }

      // 填空题：提交后手动下一题（对错都接受）
      const blank = page.getByLabel('填空答案');
      if (await blank.isVisible()) {
        await blank.fill('give up');
        await page.getByRole('button', { name: '提交' }).click();
        await Promise.race([
          page.getByText('回答正确').waitFor({ timeout: 5000 }),
          page.getByText('回答错误').waitFor({ timeout: 5000 }),
        ]);
        await page.getByRole('button', { name: '下一题' }).click();
        continue;
      }

      // 选择题：任选一项
      const options = page.getByRole('group', { name: '选项' }).getByRole('button');
      if (await options.first().isVisible()) {
        await options.first().click();
        await Promise.race([
          page.getByText('回答正确').waitFor({ timeout: 5000 }),
          page.getByText('回答错误').waitFor({ timeout: 5000 }),
        ]);
        if (await page.getByText('回答正确').isVisible()) {
          await continueAfterCorrect(page);
        } else {
          await page.getByRole('button', { name: '下一题' }).click();
        }
        continue;
      }

      await page.waitForTimeout(300);
    }

    expect(done, '练习应在有限步数内完成').toBe(true);
    await page.getByRole('button', { name: '返回详情' }).click();
    await expect(page.getByRole('heading', { name: 'give up' })).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑' })).toBeVisible();
  });
});
