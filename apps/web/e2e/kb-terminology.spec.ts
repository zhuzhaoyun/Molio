/**
 * @area kb-import
 * @priority P1
 *
 * 术语守卫：中文界面里同一个东西只有「知识库」一个名字。
 *
 * 背景：客户反馈里说不清自己在哪一步卡住的一部分原因，就是界面上
 * 「知识库 / 仓库 / 库 / vault」四种叫法混用——左侧栏叫「知识库」，
 * 点开的管理器里全叫「仓库」。用户产品决策：中文一律「知识库」，
 * 英文保留 "vault"。
 *
 * 只在用户真正看得到的地方断言（管理器、空态、资源页文案）。
 */

import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

let vault: TempVault;

test.describe('知识库术语统一', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-terminology');
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test('仓库管理器里不再出现「仓库」', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('.kb-vault-bar').first().click();
    const manager = page.locator('[data-testid="vault-manager-modal"]');
    await expect(manager).toBeVisible({ timeout: 5_000 });

    await expect(manager).not.toContainText('仓库');

    // 两级表单（打开 / 新建）都要干净
    await manager.locator('.vm-action-btn').filter({ hasText: '打开' }).click();
    await expect(page.locator('.vm-submit-btn')).toBeVisible({ timeout: 5_000 });
    await expect(manager).not.toContainText('仓库');

    await page.locator('.vm-back-btn').click().catch(() => {});
    await manager.locator('.vm-action-btn').filter({ hasText: '创建' }).click();
    await expect(page.locator('.vm-create-title')).toBeVisible({ timeout: 5_000 });
    await expect(manager).not.toContainText('仓库');
  });
});
