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

/** understanding Recall：recalled 路径——显示答案 → 自评"想起来了" → 评分即前进 */
async function recallPass(page: Page, meaning: string) {
  await page.getByRole('button', { name: '显示答案' }).click();
  await expect(page.getByText(meaning, { exact: true })).toBeVisible(); // 揭示态展示 meaning
  await page.getByRole('button', { name: '想起来了' }).click();
  // 自动前进：等自评按钮消失（冻结瞬态或已切卡）
  await expect(page.getByRole('button', { name: '想起来了' })).toHaveCount(0);
  // 判语收起 = 已真正切卡（防冻结瞬态重入循环分支）
  await expect(page.getByText('想起来了', { exact: true })).toBeHidden();
}

/**
 * 驱动会话循环直至完成摘要（主流程骨架，会话型用例共用）。返回是否在步数内完成。
 * 计划：gravity（learn）与 make sense / wear down 走 recall recalled（想起来了）；
 * stable 走 hint 选错（没想起来，错题可见于今日学习）；raw 填空答对；
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

    // 0) 表达卡（give up 原题/撤销替换题，题面不限）：提交包含目标词的句子，通过后手动下一题
    const prodInput = page.getByLabel('表达答案');
    if (await prodInput.isVisible()) {
      await prodInput.fill('The constant stress makes me want to give up.');
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

    // 3) make sense：Recall recalled 路径（显示答案 → 想起来了 → 评分即前进）
    if (await page.getByRole('heading', { name: 'make sense' }).isVisible()) {
      await recallPass(page, '讲得通');
      continue;
    }

    // 4) stable：首次出现走 Hint 选错（给我提示 → 选错误项）
    //    → 冻结"没想起来" + 正确释义与原句揭示 + 统一纠错勾选正确选项（fail，记录进今日学习）
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
      // 统一纠错：冻结后选项仍可见，正确选项「稳定的」被勾选
      await expect(
        page.getByRole('group', { name: '选项' }).getByRole('button', { name: '稳定的' }),
      ).toBeVisible();
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
    await expect(
      page.getByText(/^词汇总数 \d+ · 待学 \d+ · 今日到期 5 项 · 可新学 \d+$/),
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

    // 今日学习：按学习项去重分组，stable 组含错题轨迹；展开可只读查看作答/正确答案
    const learning = page.getByRole('list', { name: '今日学习' });
    await expect(learning).toBeVisible();
    const stableGroup = learning.getByRole('button', { name: /stable/ });
    await expect(stableGroup).toContainText('错');
    await stableGroup.click();
    // 分组 li（按钮的父节点）内展开作答记录（fail 可能另插补强题，同组多行）：首行即 hint 选错
    const stableRecords = stableGroup.locator('..').locator('ul li');
    const recordCount = await stableRecords.count();
    expect(recordCount).toBeGreaterThanOrEqual(1);
    await expect(stableRecords.first()).toContainText('未通过');
    await expect(stableRecords.first()).toContainText('正确答案');
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

    // 做完追加的 delta Learn 卡（Recall 路径：显示答案 → 想起来了）→ 回完成摘要
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

  test('撤销最近一次作答：反馈态确认撤销另排新题重练；完成页保留入口', async ({ page }) => {
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

    // 确认撤销 → 回活动队列：原题不重开，直接到下一题 make sense
    await undoIcon.click();
    await dialog.getByRole('button', { name: '撤销' }).click();
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();

    // 完成整个会话（撤销后 give up 另排一道新题在队尾，由通用表达分支处理）
    expect(await driveSessionToCompleted(page), '会话应在有限步数内完成').toBe(true);
    await expect(page.getByRole('heading', { name: '今天完成了' })).toBeVisible();
    // 完成页保留最近一次作答的撤销入口（PRODUCT §5.1）
    await expect(page.getByRole('button', { name: '撤销最近一次作答' })).toBeVisible();
  });
});

test.describe('Today 沉浸式卡（移动端，PRODUCT §5.1 一题一屏）', () => {
  // 375x480 模拟短屏 + 键盘弹出后的可视高度：输入与主操作必须仍可达
  test.use({ viewport: { width: 375, height: 480 } });

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
    await page.getByRole('button', { name: '下一题' }).click();
    await expect(page.getByRole('heading', { name: 'make sense' })).toBeVisible();
  });

  // 键盘几何用真机高度（375x812）：注入 260px 后剩余卡高需容纳 dock 最小内容高
  // （textarea 3 行 + 按钮行 ≈ 150px）；沿用外层 480 高时剩余仅 ~100px，
  // dock 收不下会向键盘区溢出，断言在本机不可能成立（与 --kb-inset 无关）
  test.describe('键盘避让（iPhone 高度）', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('键盘避让：注入 --kb-inset 后卡身压缩、顶栏不动、输入停靠键盘线上', async ({ page }) => {
      test.setTimeout(90_000);
      await login(page);
      await resetSeedData(page);
      await page.goto('/today');
      await page.getByRole('button', { name: '开始今日复习' }).click();
      await expect(page.getByText('长期的压力让我想放弃。')).toBeVisible();

      const card = page.locator('article').first();
      const nav = page.locator('nav.fixed');
      const header = page.locator('header.fixed');
      const cardBefore = (await card.boundingBox())!;
      const headerBefore = (await header.boundingBox())!;

      await page.evaluate(() =>
        document.documentElement.style.setProperty('--kb-inset', '260px'),
      );

      const cardAfter = (await card.boundingBox())!;
      const headerAfter = (await header.boundingBox())!;
      const navBox = (await nav.boundingBox())!;
      expect(headerAfter.y).toBe(headerBefore.y); // 顶栏不动
      expect(cardAfter.y).toBe(cardBefore.y); // 卡顶不动（压缩发生在底部）
      expect(cardAfter.height).toBeLessThan(cardBefore.height); // 卡身压缩
      expect(navBox.y - (cardAfter.y + cardAfter.height)).toBeGreaterThanOrEqual(258); // 卡底 ≈ 键盘线
      const inputBox = (await page.getByLabel('表达答案').boundingBox())!;
      expect(navBox.y - (inputBox.y + inputBox.height)).toBeGreaterThanOrEqual(258); // 输入框在键盘线上
    });
  });
});
