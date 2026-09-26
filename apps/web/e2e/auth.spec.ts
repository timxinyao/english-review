import { expect, test } from '@playwright/test';

test.describe('登录流程', () => {
  test('未登录访问首页被重定向到 /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('访问密码')).toBeVisible();
  });

  test('错误密码显示错误提示且不跳转', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('访问密码').fill('wrong-password');
    await page.getByRole('button', { name: '进入' }).click();
    await expect(page.getByRole('alert')).toContainText('密码不正确');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('正确密码登录后进入 Today（Phase 1 占位）', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('访问密码').fill('e2e-password');
    await page.getByRole('button', { name: '进入' }).click();
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  });

  test('登录后可打开 Settings 并看到真实设置数据', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('访问密码').fill('e2e-password');
    await page.getByRole('button', { name: '进入' }).click();
    await expect(page).toHaveURL(/\/today$/);

    await page.goto('/settings');
    await expect(page.getByText('每日新学习项上限')).toBeVisible();
    await expect(page.getByLabel('每日新学习项上限')).toHaveValue('10');
  });
});
