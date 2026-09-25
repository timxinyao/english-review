import { expect, test, type Page } from '@playwright/test';

/**
 * Stats 与 Settings 备份区（PC viewport；E2E_SEED=1 播种 6 个学习项：
 * stable / wear down / raw / make sense / gravity / give up，其中 gravity 在 New Queue）
 */
test.use({ viewport: { width: 1280, height: 720 } });

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('访问密码').fill('e2e-password');
  await page.getByRole('button', { name: '进入' }).click();
  await page.waitForURL(/\/today$/);
}

/** 会话型 spec 共享同一 e2e.db：开头重置回种子状态，保证统计口径稳定 */
async function resetSeedData(page: Page) {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/__e2e/reset', { method: 'POST', credentials: 'include' });
    return r.status;
  });
  if (res !== 200) throw new Error(`reset 失败：${res}`);
}

/** 取 dl 行中 dt 对应的 dd 值 */
function rowValue(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]');
}

test.describe('Stats 与 Settings 备份区', () => {
  test('Stats 总览、热力图与 New Queue；Settings 备份区入口', async ({ page }) => {
    await login(page);
    await resetSeedData(page);

    // ---- Stats ----
    await page.goto('/stats');
    await expect(page.getByRole('heading', { name: 'Stats' })).toBeVisible();

    // 总学习项 = 种子 6（stable/wear down/raw/make sense/gravity/give up）
    await expect(rowValue(page, '总学习项')).toHaveText(/^6/);
    // New Queue 待学 = 1（gravity 尚未开始学习）
    await expect(rowValue(page, 'New Queue 待学')).toHaveText('1');

    // 12 个月热力图：365 格（title 以「· n 个任务」结尾）
    const cells = page.locator('[title$=" 个任务"]');
    await expect(cells).toHaveCount(365);

    // ---- Settings 备份区 ----
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '备份与恢复' })).toBeVisible();
    await expect(page.getByRole('button', { name: '导出完整备份' })).toBeVisible();

    // 恢复入口：选择备份文件的输入存在（未选文件时提交按钮禁用）
    await expect(page.getByLabel('备份 JSON 文件')).toBeVisible();
    await expect(page.getByRole('button', { name: '校验并预览' })).toBeDisabled();
  });
});
