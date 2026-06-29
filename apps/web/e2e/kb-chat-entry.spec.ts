import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * Unified chat panel + scoped entry buttons:
 * - 💬问答 (document) in kb-main-header → 1 click, qa mode + @当前文档.
 * - 📚构建Wiki / 🩺健康检查 (vault) in KbTabBar actions → open + auto-send.
 * Prerequisites: `pnpm dev`.
 */
let vault: TempVault;

test.describe('KB chat entry (scoped buttons)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-chat-entry');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('💬问答 opens chat in qa mode with @当前文档 (one click)', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();

    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    // qa mode uses a fixed title (NOT the document name)
    await expect(panel.locator('.file-chat-label')).not.toContainText('doc.md');
    // composer seeded with the file as a @ ref (chip / mention present)
    await expect(panel.locator('.file-chat-input')).toContainText(/doc\.md/);
  });

  test('📚构建Wiki opens chat + auto-sends (run starts)', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-build-wiki"]').click();

    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.file-chat-label')).toContainText(/构建|Wiki|Build/);
    // a user message (the skill prompt) appears
    await expect(panel.locator('.file-chat-messages')).toContainText(/wiki-build/, { timeout: 10_000 });
  });

  test('🩺健康检查 disabled when wiki not initialized', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-btn-lint-wiki"]')).toBeDisabled();
  });

  test('💬问答 disabled when no file open', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    // no ?file= → no selectedFile → ask button absent (rendered only when selectedFile)
    await expect(page.locator('[data-testid="kb-btn-ask"]')).toHaveCount(0);
  });

  test('Cmd+K opens qa panel', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-btn-ask"]')).toBeVisible();
    await page.locator('.kb-main').click();
    await page.keyboard.press('Control+KeyK');
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
  });
});
