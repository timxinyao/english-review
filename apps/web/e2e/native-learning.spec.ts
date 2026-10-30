import { expect, test } from '@playwright/test';

// Real local E2E API/SQLite fixture, never real external pronunciation transport.
test.use({ viewport: { width: 320, height: 568 } });
test('compact learning: stable chips, feedback, visible recall meaning and modal keyboard return', async ({
  page,
}) => {
  await page.route('**/api/tts?**', (route) =>
    route.fulfill({ status: 503, body: 'Fixture audio disabled' }),
  );
  await page.goto('/login');
  await page.getByLabel('访问密码').fill('e2e-password');
  await page.getByRole('button', { name: '进入', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
  const reset = await page.request.post('/api/__e2e/reset');
  expect(reset.ok()).toBe(true);
  // Backfill an existing source sentence through the real import path, without resetting its review state.
  const translation = '他的解释在我看来很有道理。';
  const preview = await page.request.post('/api/import/preview', {
    data: {
      version: '2.0',
      items: [
        {
          type: 'chunk',
          target: 'make sense',
          meaning: '讲得通',
          source_example: 'His explanation makes sense to me.',
          source_example_translation: translation,
        },
      ],
    },
  });
  expect(preview.ok()).toBe(true);
  const previewBody = await preview.json();
  expect(previewBody.items[0].suggestion.action).toBe('merge');
  const imported = await page.request.post('/api/import/commit', {
    data: { previewToken: previewBody.previewToken, decisions: [] },
  });
  expect(imported.ok()).toBe(true);
  expect((await imported.json()).merged).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: '开始今日复习' }).click();
  const bank = page.getByTestId('scramble-chip-bank');
  await expect(bank.getByRole('button', { name: 'The', exact: true })).toBeVisible();
  const count = await bank.getByRole('button').count();
  await bank.getByRole('button', { name: 'The', exact: true }).click();
  await expect(bank.getByRole('button', { name: 'The', exact: true })).toBeDisabled();
  await expect(bank.getByRole('button')).toHaveCount(count);
  await page.getByRole('button', { name: '撤回最后一个词' }).click();
  await expect(page.getByRole('button', { name: '提交', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '不会', exact: true }).click();
  await expect(page.getByTestId('scramble-result')).toBeVisible();
  await expect(page.getByText(/不是自由造句批改/)).toBeVisible();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByText(translation, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '显示答案', exact: true }).click();
  await expect(page.getByText('讲得通', { exact: true })).toBeInViewport();
  await expect(page.getByText(translation, { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '良好', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '良好', exact: true }).click();
  await expect(page.getByText(translation, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看今日学习' }).click();
  const dialog = page.getByRole('dialog', { name: '今日学习' });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await page.getByRole('button', { name: '关闭', exact: true }).press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '查看今日学习' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'stable', exact: true })).toBeVisible();
});
