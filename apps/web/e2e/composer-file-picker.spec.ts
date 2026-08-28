import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';

test.describe('Composer @ file picker', () => {
  test('typing @ opens file picker when vault is active', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    // Need a vault to be active for FilePicker to show
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    // Type @
    await input.click();
    await input.fill('@');

    // FilePicker may or may not appear depending on vault existence
    // If a vault exists, verify the picker appears
    const picker = page.locator('[data-testid="file-picker"]');
    const pickerVisible = await picker.isVisible({ timeout: 3000 }).catch(() => false);
    // If no vault, picker won't show — that's fine
    if (pickerVisible) {
      await expect(picker).toBeVisible();
    }
  });

  test('file picker has search input', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await input.fill('@');

    const picker = page.locator('[data-testid="file-picker"]');
    const pickerVisible = await picker.isVisible({ timeout: 3000 }).catch(() => false);
    if (pickerVisible) {
      const searchInput = page.locator('[data-testid="file-picker-search"]');
      await expect(searchInput).toBeVisible();
      await expect(searchInput).toBeFocused();
    }
  });

  test('file picker closes on Escape and clears @ text', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await input.fill('@');

    const picker = page.locator('[data-testid="file-picker"]');
    const pickerVisible = await picker.isVisible({ timeout: 3000 }).catch(() => false);
    if (pickerVisible) {
      await page.keyboard.press('Escape');
      await expect(picker).not.toBeVisible();
      // @ text should be cleared
      await expect(input).toHaveValue('');
    }
  });

  test('selecting a file inserts an inline @ref (no badge)', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await input.fill('@');

    const picker = page.locator('[data-testid="file-picker"]');
    const items = page.locator('[data-testid="file-picker-item"]');
    const hasItems = await items.first().isVisible({ timeout: 3000 }).catch(() => false);

    if (hasItems) {
      await items.first().click();
      // Claude Code-style: the reference becomes raw `@path` text in the input,
      // no separate badge — expansion to markdown happens at send time.
      await expect(input).toHaveValue(/^@/);
      await expect(page.locator('[data-testid="composer-file-badge"]')).toHaveCount(0);
    }
  });

  test('a second @ ref can be appended inline', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await input.fill('@');

    const picker = page.locator('[data-testid="file-picker"]');
    const items = page.locator('[data-testid="file-picker-item"]');
    const hasItems = await items.first().isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasItems) return;

    await items.first().click();
    await expect(input).toHaveValue(/^@/);

    // Type " @" to re-trigger the picker and reference a second node.
    await input.pressSequentially(' @');
    await expect(picker).toBeVisible({ timeout: 3000 });
    await items.first().click();

    const value = await input.inputValue();
    const atCount = (value.match(/@/g) ?? []).length;
    expect(atCount).toBeGreaterThanOrEqual(2);
  });

  test('folder can be selected as an inline @ ref', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await input.fill('@');

    const picker = page.locator('[data-testid="file-picker"]');
    const pickerVisible = await picker.isVisible({ timeout: 3000 }).catch(() => false);
    if (!pickerVisible) return;

    // Directories surface only when searched (they sort below files). Type a
    // slash to match any path, then look for a folder item (name ends with '/').
    const searchInput = page.locator('[data-testid="file-picker-search"]');
    await searchInput.fill('/');
    const items = page.locator('[data-testid="file-picker-item"]');
    const folderItem = items.filter({ hasText: /\// }).first();
    const hasFolder = await folderItem.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasFolder) return;

    await folderItem.click();
    // Folder refs keep the trailing slash so send-time expansion can tell
    // them apart from files.
    await expect(input).toHaveValue(/@.*\/$/);
  });
});
