/**
 * @area kb-import
 * @priority P0
 *
 * 「导入文件」必须是看得见的动作。
 * 背景：曾经全 UI 没有任何导入按钮，唯一进库路径是「拖文件到左侧面板」这一隐式交互，
 * 导致客户反馈「不知道怎么把文件加进知识库」。本 spec 锁死该入口的常驻可见性。
 */

import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

let vault: TempVault;
let emptyVault: TempVault;

/** 导入弹窗 = 带拖拽区的那个 kb-modal（同页还有 vault 管理器等其他 modal）。 */
function importDialog(page: import('@playwright/test').Page) {
  return page.locator('.kb-modal').filter({ has: page.locator('.kb-dropzone') });
}

test.describe('KB 导入入口', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-import-entry');
    emptyVault = await createTempVault('e2e-kb-import-entry-empty');
    fs.unlinkSync(path.join(emptyVault.path, 'test.md'));
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
    if (emptyVault) await cleanupTempVault(emptyVault);
  });

  test('文件面板工具栏有常驻的「导入」按钮', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-btn-import"]')).toBeVisible({ timeout: 5_000 });
  });

  test('点「导入」按钮打开导入弹窗', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-import"]').click();

    const dialog = importDialog(page);
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.locator('.kb-dropzone')).toBeVisible();
  });

  test('导入弹窗是中文的，并标明文件会落到哪个库', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await page.locator('[data-testid="kb-btn-import"]').click();

    const dialog = importDialog(page);
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // 逐处断言，别用整个 dialog 的 toContainText —— 弹窗里别的中文（拖拽提示、
    // 提交按钮）会把标题的英文兜住，那样断言就抓不到回归了（实测过）。
    const title = dialog.locator('h2');
    await expect(title).toContainText('导入到');
    await expect(title).toContainText(vault.name);
    await expect(dialog.locator('.kb-dropzone')).toContainText(/拖|导入/);
    await expect(dialog.locator('[data-testid="kb-import-submit"]')).toContainText(/导入/);
  });

  test('一个知识库都没有时，知识库页空态给出建库入口（不是死胡同）', async ({ page }) => {
    await page.route('**/api/knowledge/vaults', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { vaults: [] } }) : route.continue(),
    );
    await page.goto('http://localhost:5173/knowledge');

    const cta = page.locator('[data-testid="kb-empty-create-vault-cta"]');
    await expect(cta).toBeVisible({ timeout: 10_000 });

    await cta.click();
    await expect(page.locator('[data-testid="vault-manager-modal"]')).toBeVisible({ timeout: 5_000 });
  });

  test('空库的文件树空态给出拖拽/导入提示（不是英文空话）', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${emptyVault.id}`);

    const hint = page.locator('[data-testid="kb-tree-empty-hint"]');
    await expect(hint).toBeVisible({ timeout: 5_000 });
    // 提示必须指向一个真实存在的动作，否则跟原来那句英文一样无用
    await expect(hint).toContainText(/导入|拖/);
  });

  test('空库首屏的主 CTA 是「导入文件」，点击同样打开导入弹窗', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${emptyVault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const cta = page.locator('[data-testid="kb-empty-import-cta"]');
    await expect(cta).toBeVisible({ timeout: 5_000 });

    await cta.click();
    await expect(importDialog(page)).toBeVisible({ timeout: 5_000 });
  });
});
