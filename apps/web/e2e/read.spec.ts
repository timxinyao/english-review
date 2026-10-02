import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 9 Read 全流程（PC viewport；E2E_SEED=1 播种：
 * 生成不走 AI，返回确定性纯文章：title "A Quiet Morning"、type story、
 * 正文含全部 focus 原词、无 checks。
 * 另播种一篇 V1 遗留文章 "An Old Lesson"：checks_json 含一答错 + 一未答检查题，
 * 详情只读回放、无提交入口。）
 */
test.use({ viewport: { width: 1280, height: 720 } });

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('访问密码').fill('e2e-password');
  await page.getByRole('button', { name: '进入' }).click();
  await page.waitForURL(/\/today$/);
}

/** 会话型 spec 共享同一 e2e.db：开头重置回种子状态（清掉历史运行的文章） */
async function resetSeedData(page: Page) {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/__e2e/reset', { method: 'POST', credentials: 'include' });
    return r.status;
  });
  if (res !== 200) throw new Error(`reset 失败：${res}`);
}

test.describe('Phase 9：纯 Read 生成、高亮、遗留检查题只读、收藏与历史', () => {
  test('生成纯阅读（无检查题）→ 高亮 → 收藏 → 历史可见；遗留文章检查题只读', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await resetSeedData(page);
    await page.goto('/read');

    // 首屏：唯一主动作 + 最近列表 + 历史入口
    await expect(page.getByRole('heading', { name: 'Read' })).toBeVisible();
    await expect(page.getByRole('button', { name: '生成阅读' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '查看全部历史' })).toBeVisible();

    // 生成：正计时或文章标题出现（种子数据即时返回，避免竞态）
    await page.getByRole('button', { name: '生成阅读' }).click();
    await expect(
      page.locator('[data-elapsed]').or(page.getByRole('heading', { name: 'A Quiet Morning' })),
    ).toBeVisible({ timeout: 30_000 });

    // 文章视图：标题 / 生成耗时 / 高亮 / focus 词列表
    await expect(page.getByRole('heading', { name: 'A Quiet Morning' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/生成耗时 \d+s/)).toBeVisible();
    const marks = page.locator('mark');
    await expect(marks.first()).toBeVisible();
    expect(await marks.count()).toBeGreaterThan(0);
    await expect(page.getByText('重点复现')).toBeVisible();

    // V2 纯阅读：不渲染检查题区、无提交按钮
    await expect(page.getByText('检查题（历史）')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '提交' })).toHaveCount(0);

    // 收藏星标：点击后即时生效
    const star = page.getByRole('button', { name: '收藏文章' });
    await star.click();
    await expect(page.getByRole('button', { name: '取消收藏文章' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // 返回首页 → 进入历史
    await page.getByRole('button', { name: '← 返回 Read' }).click();
    await page.getByRole('button', { name: '查看全部历史' }).click();

    // 历史列表：含本文且带星标
    await expect(page.getByRole('heading', { name: 'Read 历史' })).toBeVisible();
    const row = page.locator('li').filter({ hasText: 'A Quiet Morning' });
    await expect(row).toBeVisible();
    await expect(row.locator('svg').first()).toBeVisible();

    // 遗留文章：打开详情 → 检查题只读回放（答错提示 + 未答说明），无提交入口
    const legacyRow = page.locator('li').filter({ hasText: 'An Old Lesson' });
    await expect(legacyRow).toBeVisible();
    await legacyRow.locator('button').first().click();
    await expect(page.getByRole('heading', { name: 'An Old Lesson' })).toBeVisible();

    await expect(page.getByText('检查题（历史）')).toBeVisible();
    const answeredCheck = page.getByRole('group', { name: '检查题 1' });
    await expect(answeredCheck.getByText('答错了')).toBeVisible();
    await expect(answeredCheck.getByText(/^正确选项：/)).toBeVisible();
    const openCheck = page.getByRole('group', { name: '检查题 2' });
    await expect(openCheck.getByText('历史检查题，仅供查看')).toBeVisible();
    await expect(page.getByRole('button', { name: '提交' })).toHaveCount(0);

    // 返回历史 → 筛选“收藏”仍可见
    await page.getByRole('button', { name: '← 返回历史' }).click();
    await page.getByRole('button', { name: '收藏', exact: true }).click();
    await expect(page.locator('li').filter({ hasText: 'A Quiet Morning' })).toBeVisible();
  });
});
