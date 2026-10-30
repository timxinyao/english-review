import { expect, test, type Page } from '@playwright/test';

/**
 * Today 与 Library 练习的拼词表达题（PC viewport，E2E_SEED=1）：
 * give up 使用预置拼词题；正式和练习作答按词序判定，不自动保存个人例句。
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

test.describe('Phase 4：表达题批改与 Library 练一下', () => {
  test('Today 拼词表达题：提交完整句 → 按词条通过 → 完成会话', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');

    // 种子会话为 4 道复习 + 1 道新学。
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await page.getByRole('button', { name: '开始今日复习' }).click();
    await expect(page.getByRole('button', { name: '查看今日学习' })).toContainText('今日 0 / 5');

    let productionDone = false;
    let completed = false;
    for (let step = 0; step < 40 && !completed; step++) {
      if (await page.getByRole('heading', { name: '今天完成了' }).isVisible()) {
        completed = true;
        break;
      }

      // 1) 拼词表达题卡（give up）
      if (await page.getByText('长期的压力让我想放弃。').isVisible()) {
        productionDone = true;
        await expect(page.getByText('give up')).toBeVisible();
        const bank = page.getByTestId('scramble-chip-bank');
        for (const tok of [
          'The',
          'constant',
          'stress',
          'makes',
          'me',
          'want',
          'to',
          'give',
          'up',
        ]) {
          await bank.getByRole('button', { name: tok, exact: true }).click();
        }
        await page.getByRole('button', { name: '提交' }).click();
        const result = page.getByTestId('scramble-result');
        await expect(result).toContainText('通过');
        await expect(result).toContainText('The constant stress makes me want to give up');
        await expect(result.getByRole('listitem')).toContainText('give up');
        await expect(result.getByRole('listitem')).toContainText('对');
        await page.getByRole('button', { name: '继续' }).click();
        continue;
      }

      // 2) Learn 卡（gravity，Recall Card）：显示答案 → 良好 → 评分即前进
      if (await page.getByText('I laugh at gravity all the time.').isVisible()) {
        await expect(page.getByRole('heading', { name: 'gravity' })).toBeVisible();
        await page.getByRole('button', { name: '显示答案' }).click();
        await expect(page.getByText('重力', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '良好' }).click();
        // 评分即前进：等自评按钮消失即已切卡
        await expect(page.getByRole('button', { name: '良好' })).toHaveCount(0);
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

      // 4) understanding Recall 卡（stable / wear down / make sense 及理解补强）：
      //    显示答案 → 良好 → 评分即前进（RecallCard 无默认选项组）
      const reveal = page.getByRole('button', { name: '显示答案' });
      if (await reveal.isVisible()) {
        await reveal.click();
        await page.getByRole('button', { name: '良好' }).click();
        // 评分即前进：等自评按钮消失即已切卡
        await expect(page.getByRole('button', { name: '良好' })).toHaveCount(0);
        continue;
      }

      // 5) 未知补强选择题：任选一项，对错都收尾后继续
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

  test('Library 详情：拼词作答记录通过，且不自动保存个人例句', async ({ page }) => {
    await login(page);
    await resetSeedData(page);
    await page.goto('/today');
    await page.getByRole('button', { name: '开始今日复习' }).click();
    await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();
    const bank = page.getByTestId('scramble-chip-bank');
    for (const token of ['The', 'constant', 'stress', 'makes', 'me', 'want', 'to', 'give', 'up']) {
      await bank.getByRole('button', { name: token, exact: true }).click();
    }
    await page.getByRole('button', { name: '提交', exact: true }).click();
    const result = page.getByTestId('scramble-result');
    await expect(result).toContainText('通过');
    await expect(result.getByRole('listitem')).toContainText('give up');
    await expect(result.getByRole('listitem')).toContainText('对');

    await page.goto('/library');
    await page.getByLabel('搜索学习项').fill('give up');
    await page
      .getByRole('link', { name: /give up/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/library\/[a-z0-9-]+$/i);
    const sentence = 'The constant stress makes me want to give up';
    const historyItems = page.locator('section[aria-label="造句历史"] li');
    await expect(historyItems).toHaveCount(1);
    await expect(historyItems).toContainText(sentence);
    await expect(historyItems).toContainText('通过');

    const itemId = page.url().match(/\/library\/([^/]+)$/)?.[1];
    expect(itemId).toBeTruthy();
    const detail = await page.evaluate(async (id) => {
      const response = await fetch(`/api/library/${id}`, { credentials: 'include' });
      return (await response.json()) as {
        personalExamples: Array<{ text: string }>;
        productionHistory: Array<{ originalText: string | null; result: string; mode: string }>;
      };
    }, itemId);
    expect(detail.productionHistory).toHaveLength(1);
    expect(detail.productionHistory[0]).toMatchObject({
      originalText: sentence,
      result: 'pass',
      mode: 'today',
    });
    expect(detail.personalExamples.map((example) => example.text)).not.toContain(sentence);
  });

  test('Library 练一下：Recall 自评与释义揭示 → 拼词通过 → 返回详情', async ({ page }) => {
    await login(page);
    await resetSeedData(page);
    await page.goto('/library');

    await page.getByLabel('搜索学习项').fill('give up');
    await page
      .getByRole('link', { name: /give up/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/library\/[a-z0-9-]+$/i);

    await page.getByRole('button', { name: '练一下' }).click();
    // V2（Phase 9）：word + production 开 → 恰好 2 题（recall → production），无 cloze
    await expect(page.getByText(/^\d+ \/ 2$/)).toBeVisible();

    // 第 1 题 Recall 卡：词面 + 原句；释义（reveal）作答前不可见
    await expect(page.getByRole('heading', { name: 'give up' })).toBeVisible();
    await expect(page.getByText('After months of failure, he refused to give up.')).toBeVisible();
    await expect(page.getByText('放弃', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '良好' }).click();
    await expect(page.getByText('良好', { exact: true })).toBeVisible();
    await expect(page.getByText('放弃', { exact: true })).toBeVisible(); // 释义揭示
    await page.getByRole('button', { name: '下一题' }).click();

    // 第 2 题 拼词表达（库存题面可能是压力句或吸烟句）
    await expect(page.getByTestId('scramble-chip-bank')).toBeVisible();
    const bank1 = page.getByTestId('scramble-chip-bank');
    const giveUpTokens = ['The', 'constant', 'stress', 'makes', 'me', 'want', 'to', 'give', 'up'];
    const smokeTokens = ['He', 'decided', 'to', 'give', 'up', 'smoking', 'last', 'year'];
    const prompt = page.locator('article').getByText(/长期的压力让我想放弃。|他去年决定放弃吸烟。/);
    await expect(prompt).toBeVisible();
    const promptText = await prompt.textContent();
    const tokens1 = promptText === '长期的压力让我想放弃。' ? giveUpTokens : smokeTokens;
    for (const tok of tokens1) {
      await bank1.getByRole('button', { name: tok, exact: true }).click();
    }
    await page.getByRole('button', { name: '提交' }).click();
    await expect(page.getByTestId('scramble-result')).toBeVisible();
    await expect(page.getByText('通过', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '继续' }).click();

    await expect(page.getByText('练习完成')).toBeVisible();
    await page.getByRole('button', { name: '返回详情' }).click();
    await expect(page.getByRole('heading', { name: 'give up' })).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑' })).toBeVisible();
  });
});

test.describe('Phase 9（Task 10）：练一下按有效造句目标选择性出题', () => {
  test('word 默认关只出 Recall；chunk 默认开出 Recall + 表达；全程无填空', async ({ page }) => {
    await login(page);
    await resetSeedData(page);

    // ---- stable（word、override=null → 默认关）：恰好 1 题 Recall，无表达题 ----
    await page.goto('/library');
    await page.getByLabel('搜索学习项').fill('stable');
    await page
      .getByRole('link', { name: /stable/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/library\/[a-z0-9-]+$/i);
    await page.getByRole('button', { name: '练一下' }).click();

    await expect(page.getByText('1 / 1', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'stable' })).toBeVisible();
    await expect(page.getByText('The connection has been stable all week.')).toBeVisible();
    await expect(page.getByText('稳定的', { exact: true })).toHaveCount(0); // 释义揭示前不泄露
    await expect(page.getByTestId('scramble-chip-bank')).toHaveCount(0); // 默认关：无表达题
    await expect(page.getByLabel('填空答案')).toHaveCount(0); // V2：练习不再出旧填空

    await page.getByRole('button', { name: '良好' }).click();
    await expect(page.getByText('稳定的', { exact: true })).toBeVisible(); // 作答后揭示
    await page.getByRole('button', { name: '下一题' }).click();
    await expect(page.getByText('练习完成')).toBeVisible();
    await page.getByRole('button', { name: '返回详情' }).click();

    // ---- make sense（chunk、override=null → 默认开）：Recall → 表达 恰好 2 题 ----
    await page.goto('/library');
    await page.getByLabel('搜索学习项').fill('make sense');
    await page
      .getByRole('link', { name: /make sense/ })
      .first()
      .click();
    await page.getByRole('button', { name: '练一下' }).click();

    await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();
    await expect(page.getByText('讲得通', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '良好' }).click();
    await expect(page.getByText('讲得通', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一题' }).click();

    // 第 2 题 拼词表达（make sense）
    await expect(page.getByText('make sense')).toBeVisible();
    const bank2 = page.getByTestId('scramble-chip-bank');
    await expect(bank2).toBeVisible();
    const seedPrompt = page.getByText('他的解释完全讲得通。', { exact: true });
    const mockPrompt = page.getByText('请用所给词块表达：讲得通', { exact: true });
    await expect(seedPrompt.or(mockPrompt)).toBeVisible();
    const tokens2 = (await seedPrompt.isVisible())
      ? ['His', 'explanation', 'makes', 'complete', 'sense', 'to', 'me']
      : ['People', 'often', 'make', 'sense', 'here', 'daily'];
    for (const tok of tokens2) {
      await bank2.getByRole('button', { name: tok, exact: true }).click();
    }
    await page.getByRole('button', { name: '提交' }).click();
    await expect(page.getByTestId('scramble-result')).toBeVisible();
    await expect(page.getByText('通过', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '继续' }).click();
    await expect(page.getByText('练习完成')).toBeVisible();
    await expect(page.getByLabel('填空答案')).toHaveCount(0);
  });
});
