import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

let vault: TempVault;

test.describe('KB Command Launcher + collapse-all', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-cmd-launcher');
    fs.mkdirSync(path.join(vault.path, 'dirA'));
    fs.mkdirSync(path.join(vault.path, 'dirA', 'subA'));
    fs.writeFileSync(path.join(vault.path, 'dirA', 'a.md'), '# A\n');
    fs.writeFileSync(path.join(vault.path, 'dirA', 'subA', 's.md'), '# S\n');
    fs.writeFileSync(path.join(vault.path, 'root.md'), '# Root\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('launcher lists commands; 问答/build enabled, lint + AI disabled', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=root.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-cmd-launcher-btn"]').click();
    const menu = page.locator('[data-testid="kb-cmd-launcher"]');
    await expect(menu).toBeVisible();

    // 问答 enabled (a file is open); 构建 Wiki enabled (vault active)
    await expect(menu.locator('[data-testid="cmd-item-ask"]')).not.toBeDisabled();
    await expect(menu.locator('[data-testid="cmd-item-build-wiki"]')).not.toBeDisabled();
    // Wiki 健康检查 disabled — fresh vault, wiki not initialized
    await expect(menu.locator('[data-testid="cmd-item-lint-wiki"]')).toBeDisabled();

    // Phase 3 AI items disabled with "coming soon" title
    const ai = menu.locator('[data-testid="cmd-item-ai-summary"]');
    await expect(ai).toBeDisabled();
    await expect(ai).toHaveAttribute('title', /即将上线|Coming soon/);

    // ESC closes
    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
  });

  test('collapse/expand toggle reflects tree state and switches icon', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=root.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const toggle = page.locator('[data-testid="kb-btn-collapse-all"]');
    await expect(toggle).toBeVisible();

    // Wait for the tree to load (dirA label is always visible, children hidden)
    await expect(page.locator('.kb-tree-group-label').filter({ hasText: 'dirA' })).toBeVisible({ timeout: 10_000 });

    // Initially all collapsed → button offers "展开全部"
    await expect(toggle).toHaveAttribute('title', '展开全部');

    // Click → expand all → nested files become visible, button flips to "折叠全部"
    await toggle.click();
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'a.md' })).toBeVisible();
    await expect(page.locator('.kb-tree-item').filter({ hasText: 's.md' })).toBeVisible();
    await expect(toggle).toHaveAttribute('title', '折叠全部');

    // Click → collapse all → nested files hidden, button flips back to "展开全部"
    await toggle.click();
    await expect(page.locator('.kb-tree-item').filter({ hasText: 's.md' })).not.toBeVisible();
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'a.md' })).not.toBeVisible();
    await expect(toggle).toHaveAttribute('title', '展开全部');

    // Manual expand of one dir also flips the button to "折叠全部"
    await page.locator('.kb-tree-group-label').filter({ hasText: 'dirA' }).first().click();
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'a.md' })).toBeVisible();
    await expect(toggle).toHaveAttribute('title', '折叠全部');
  });
});
