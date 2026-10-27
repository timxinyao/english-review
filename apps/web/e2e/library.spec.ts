import { expect, test, type Page } from '@playwright/test';

// PRODUCT §4.1：导入只在 PC 提供；按任务要求使用 PC viewport
test.use({ viewport: { width: 1280, height: 720 } });

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('访问密码').fill('e2e-password');
  await page.getByRole('button', { name: '进入' }).click();
  await page.waitForURL(/\/today$/);
}

/** e2e.db 会跨运行保留数据，用唯一后缀保证每次运行的新项可搜索、可定位 */
function uniqueStamp(): string {
  return Date.now().toString(36);
}

function importDoc(stamp: string, target1: string, target2: string) {
  return {
    version: '1.2',
    items: [
      {
        type: 'chunk',
        target: target1,
        meaning: `逐渐使……疲惫（${stamp}）`,
        ipa: null,
        source_example: 'It wears you down.',
        extra_examples: [],
        source: 'Avatar S01E12',
        source_url: null,
        tags: ['Avatar'],
        notes: null,
      },
      {
        type: 'word',
        target: target2,
        meaning: `有韧性的（${stamp}）`,
        ipa: null,
        source_example: 'The city stayed resilient after the storm.',
        extra_examples: [],
        source: null,
        source_url: null,
        tags: [],
        notes: null,
      },
    ],
  };
}

test.describe('Library 与 PC 导入流程', () => {
  test('V2 重复导入的造句目标冲突须逐项确认', async ({ page }) => {
    await login(page);
    await page.goto('/library');
    const stamp = uniqueStamp();
    const item = {
      type: 'word',
      target: `goal ${stamp}`,
      meaning: `目标（${stamp}）`,
      source_example: 'The goal is clear.',
      extra_examples: [],
      tags: [],
    };
    await page.getByRole('button', { name: '导入' }).click();
    await page
      .getByLabel('粘贴学习库 JSON')
      .fill(JSON.stringify({ version: '2.0', items: [item] }));
    await page.getByRole('button', { name: '预览' }).click();
    await page.getByRole('button', { name: /确认导入/ }).click();
    await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    await page.getByRole('button', { name: '返回 Library 列表' }).click();

    await page.getByRole('button', { name: '导入' }).click();
    await page
      .getByLabel('粘贴学习库 JSON')
      .fill(
        JSON.stringify({ version: '2.0', items: [{ ...item, production_enabled_override: true }] }),
      );
    await page.getByRole('button', { name: '预览' }).click();
    await expect(page.getByText(/按类型默认.*需要造句/)).toBeVisible();
    await expect(page.getByRole('button', { name: /确认导入/ })).toBeDisabled();
    await page.getByRole('checkbox', { name: /确认第 1 项造句目标变化/ }).check();
    await expect(page.getByRole('button', { name: /确认导入/ })).toBeEnabled();
    await page.getByRole('button', { name: /确认导入/ }).click();
    await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    await expect(page.getByText(/合并 1/)).toBeVisible();
  });

  test('列表页加载并显示搜索与筛选', async ({ page }) => {
    await login(page);
    await page.goto('/library');

    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
    await expect(page.getByLabel('搜索学习项')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Word' })).toBeVisible();
    await expect(page.getByRole('button', { name: '学习中' })).toBeVisible();
    await expect(page.getByRole('button', { name: '已归档' })).toBeVisible();
  });

  test('非法 JSON 在前端被拦截并逐条提示', async ({ page }) => {
    await login(page);
    await page.goto('/library');

    await page.getByRole('button', { name: '导入' }).click();
    await page.getByLabel('粘贴学习库 JSON').fill(
      JSON.stringify({
        version: '1.2',
        items: [{ type: 'word', meaning: '缺 target', source_example: 'x' }],
      }),
    );
    await page.getByRole('button', { name: '预览' }).click();

    await expect(page.getByRole('alert')).toContainText('第 1 项');
    // 未发起预览请求，停留在输入步骤
    await expect(page.getByLabel('粘贴学习库 JSON')).toBeVisible();
  });

  test('导入粘贴 JSON → 预览 → 改一条决定 → 提交 → 列表可见 → 详情见 source example', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/library');

    const stamp = uniqueStamp();
    const target1 = `wear down ${stamp}`;
    const target2 = `resilient ${stamp}`;
    const sourceExample2 = 'The city stayed resilient after the storm.';

    // 步骤 1：粘贴 JSON
    await page.getByRole('button', { name: '导入' }).click();
    await page
      .getByLabel('粘贴学习库 JSON')
      .fill(JSON.stringify(importDoc(stamp, target1, target2)));
    await page.getByRole('button', { name: '预览' }).click();

    // 步骤 2：预览（每行 target/meaning/source_example + 建议徽标）
    await expect(page.getByRole('heading', { name: '导入预览' })).toBeVisible();
    await expect(page.getByText(target1)).toBeVisible();
    await expect(page.getByText(target2)).toBeVisible();
    await expect(page.getByText('It wears you down.')).toBeVisible();
    await expect(page.getByText(sourceExample2)).toBeVisible();
    // 建议徽标存在（合并/新增/跳过之一，具体取决于库内重复情况）
    await expect(page.locator('li span[title]').first()).toBeVisible();

    // 改一条决定：第 1 项改为跳过
    await page.getByLabel('决定：第 1 项').selectOption('skip_exact_duplicate');
    // 全部采用建议后可再覆盖验证（此处保持跳过用于提交验证）
    await page.getByRole('button', { name: /确认导入/ }).click();

    // 步骤 3：摘要
    await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    await expect(page.getByText(/跳过 1/)).toBeVisible();

    // 返回列表并搜索新项
    await page.getByRole('button', { name: '返回 Library 列表' }).click();
    await page.getByLabel('搜索学习项').fill(target2);
    const row = page.getByRole('link', { name: new RegExp(target2) });
    await expect(row).toBeVisible();

    // 打开详情看到 source example
    await row.click();
    await expect(page).toHaveURL(/\/library\/[a-z0-9-]+$/i);
    await expect(page.getByText(sourceExample2)).toBeVisible();
  });

  test('详情页操作入口可见（编辑/暂停/归档/重置进度/标记已掌握）', async ({ page }) => {
    await login(page);
    await page.goto('/library');

    const stamp = uniqueStamp();
    const target = `resilient ${stamp}`;
    await page.getByRole('button', { name: '导入' }).click();
    await page.getByLabel('粘贴学习库 JSON').fill(
      JSON.stringify({
        version: '1.2',
        items: [
          {
            type: 'word',
            target,
            meaning: `有韧性的（${stamp}）`,
            ipa: null,
            source_example: 'A resilient team adapts fast.',
            extra_examples: [],
            tags: [],
          },
        ],
      }),
    );
    await page.getByRole('button', { name: '预览' }).click();
    await expect(page.getByRole('heading', { name: '导入预览' })).toBeVisible();
    await page.getByRole('button', { name: /确认导入/ }).click();
    await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible();
    await page.getByRole('button', { name: '返回 Library 列表' }).click();

    await page.getByLabel('搜索学习项').fill(target);
    await page.getByRole('link', { name: new RegExp(target) }).click();

    await expect(page.getByText('A resilient team adapts fast.')).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑' })).toBeVisible();
    // 暂停/归档等收进「更多」（2026-10-27 详情主次降压）：先展开再断言
    await page.getByRole('button', { name: '更多' }).click();
    await expect(page.getByRole('button', { name: '暂停' })).toBeVisible();
    await expect(page.getByRole('button', { name: '归档' })).toBeVisible();
    await expect(page.getByRole('button', { name: '重置进度' })).toBeVisible();
    await expect(page.getByRole('button', { name: '标记已掌握' })).toBeVisible();

    await page.getByRole('button', { name: '编辑' }).click();
    const goal = page.getByLabel('造句目标');
    await expect(goal).toHaveValue('default');
    await goal.selectOption('enabled');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('button', { name: '编辑' })).toBeVisible();
    await page.getByRole('button', { name: '编辑' }).click();
    await expect(page.getByLabel('造句目标')).toHaveValue('enabled');
    await page.getByLabel('造句目标').selectOption('disabled');
    await page.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: '编辑' }).click();
    await expect(page.getByLabel('造句目标')).toHaveValue('disabled');
    await page.getByLabel('造句目标').selectOption('default');
    await page.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: '编辑' }).click();
    await expect(page.getByLabel('造句目标')).toHaveValue('default');
  });
});
