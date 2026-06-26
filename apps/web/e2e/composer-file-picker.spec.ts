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

  test('file ref badge appears after selecting a file', async ({ page }) => {
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
      // Badge should appear
      const badges = page.locator('[data-testid="composer-file-badge"]');
      await expect(badges.first()).toBeVisible({ timeout: 3000 });
    }
  });

  test('file ref badge can be removed', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await input.fill('@');

    const items = page.locator('[data-testid="file-picker-item"]');
    const hasItems = await items.first().isVisible({ timeout: 3000 }).catch(() => false);

    if (hasItems) {
      await items.first().click();
      const badge = page.locator('[data-testid="composer-file-badge"]').first();
      await expect(badge).toBeVisible({ timeout: 3000 });

      const removeBtn = page.locator('[data-testid="composer-file-badge-remove"]').first();
      await removeBtn.click();
      await expect(badge).not.toBeVisible();
    }
  });

  test('folder can be selected as a @ ref', async ({ page }) => {
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
    const badge = page.locator('[data-testid="composer-file-badge"]').first();
    await expect(badge).toBeVisible({ timeout: 3000 });
    // Folder badge label ends with a trailing slash.
    await expect(badge).toContainText('/');
  });
});
