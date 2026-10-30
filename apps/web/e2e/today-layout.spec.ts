import { expect, test, type Page } from '@playwright/test';

async function startReview(page: Page) {
  await page.goto('/login');
  await page.getByLabel('访问密码').fill('e2e-password');
  await page.getByRole('button', { name: '进入', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
  expect((await page.request.post('/api/__e2e/reset')).ok()).toBe(true);
  // A long source translation exercises the revealed card's internal scrolling.
  const preview = await page.request.post('/api/import/preview', {
    data: {
      version: '2.0',
      items: [
        {
          type: 'chunk',
          target: 'make sense',
          meaning: '讲得通',
          source_example: 'His explanation makes sense to me.',
          source_example_translation: '他的解释在我看来很有道理。'.repeat(30),
        },
      ],
    },
  });
  expect(preview.ok()).toBe(true);
  const body = await preview.json();
  expect(
    (
      await page.request.post('/api/import/commit', {
        data: { previewToken: body.previewToken, decisions: [] },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '开始今日复习' }).click();
  await expect(page.getByTestId('scramble-chip-bank')).toBeVisible();
}

for (const { name, width, height, safeBottom } of [
  { name: 'narrow', width: 320, height: 568, safeBottom: 0 },
  { name: 'phone', width: 390, height: 844, safeBottom: 0 },
  { name: 'safe-area', width: 390, height: 844, safeBottom: 34 },
]) {
  test(`${name}: active card clears header and leaves 20px above navigation`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    if (safeBottom) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 24, bottom: safeBottom },
      });
    }
    await startReview(page);
    const card = page.locator('.h-today-viewport article');
    const header = page.locator('header');
    const nav = page.getByRole('navigation', { name: '底部导航' });
    await expect(card).toBeVisible();
    await page.screenshot({ path: `/tmp/warm-review-${name}.png` });
    const [cardBox, headerBox, navBox] = await Promise.all([
      card.boundingBox(),
      header.boundingBox(),
      nav.boundingBox(),
    ]);
    expect(cardBox && headerBox && navBox).toBeTruthy();
    if (safeBottom) {
      expect(headerBox!.height).toBe(87);
      expect(navBox!.height).toBe(83);
    }
    expect(cardBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
    expect(navBox!.y - (cardBox!.y + cardBox!.height)).toBeCloseTo(20, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await expect(page.getByRole('button', { name: '不会', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: '不会', exact: true }).click();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByRole('button', { name: '显示答案', exact: true }).click();
    await expect(page.getByRole('button', { name: '良好', exact: true })).toBeInViewport();
    const body = card.locator('[data-slot=body]');
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({ path: `/tmp/warm-review-${name}-revealed.png` });
    const revealedCard = (await card.boundingBox())!;
    expect(navBox!.y - (revealedCard.y + revealedCard.height)).toBeCloseTo(20, 0);
  });
}

test('desktop: active review has no mobile tab bar or horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await startReview(page);
  await expect(
    page.getByRole('navigation', { name: '底部导航', includeHidden: true }),
  ).toBeHidden();
  await expect(page.getByRole('button', { name: '不会', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await page.screenshot({ path: '/tmp/warm-review-desktop.png' });
});

// Exercise the CSS branches retained for legacy keyboard-capable Today cards.
test('keyboard transition keeps pointer target stable and docks at the visible edge', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startReview(page);
  const card = page.locator('.h-today-viewport article');
  const before = (await card.boundingBox())!;
  await page.evaluate(() => {
    const root = document.documentElement;
    root.style.setProperty('--kb-baseline-height', '844px');
    root.style.setProperty('--kb-visible-height', '500px');
    root.setAttribute('data-today-touch-pending', '');
  });
  const pending = (await card.boundingBox())!;
  expect(pending.y + pending.height).toBeCloseTo(before.y + before.height, 0);
  await page.evaluate(() => {
    const root = document.documentElement;
    root.removeAttribute('data-today-touch-pending');
    root.setAttribute('data-today-keyboard-primed', '');
    root.style.setProperty('--kb-prime-visible-height', '450px');
  });
  const primed = (await card.boundingBox())!;
  expect(primed.y + primed.height).toBeCloseTo(450, 0);
  await page.evaluate(() => {
    document.querySelector('[data-today-route]')!.setAttribute('data-keyboard-open', '');
  });
  const opened = (await card.boundingBox())!;
  expect(opened.y + opened.height).toBeCloseTo(500, 0);
});
