import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';

const TEST_VAULT_ID = 'e2e-image-paste-vault';
const UPLOADED_FILE_PATH = '.molio/assets/e2e-test-1.png';

test.describe('Composer image paste', () => {
  test('pasting an image inserts markdown', async ({ page }) => {
    // Mock vault list so an active vault exists for the paste handler.
    // The vaultStore auto-selects the first vault, so this vault becomes active.
    await page.route('**/api/knowledge/vaults', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          json: {
            vaults: [
              {
                id: TEST_VAULT_ID,
                name: 'E2E Image Paste Vault',
                path: '/tmp/e2e-image-paste-vault',
                fileCount: 0,
                createdAt: Date.now(),
              },
            ],
          },
        });
      } else {
        await route.continue();
      }
    });

    // Mock upload API to return a synthetic file path without writing to disk
    await page.route(
      `**/api/knowledge/vaults/${TEST_VAULT_ID}/assets/upload`,
      async (route) => {
        await route.fulfill({
          json: {
            filePath: UPLOADED_FILE_PATH,
            url: `/api/knowledge/vaults/${TEST_VAULT_ID}/raw/.molio/assets/e2e-test-1.png`,
          },
        });
      },
    );

    await gotoHome(page);
    // Reload to pick up the mocked vault list (fetched on mount)
    await page.reload({ waitUntil: 'networkidle' });

    const composer = page.locator('[data-testid="composer-input"]');
    await expect(composer).toBeVisible();

    // Dispatch a synthetic paste event carrying a minimal valid PNG.
    await composer.evaluate((el) => {
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
        0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x68, 0x00, 0x00, 0x00,
        0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      const blob = new Blob([pngBytes], { type: 'image/png' });
      const file = new File([blob], 'screenshot.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.focus();
      el.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Wait for async upload + React re-render to complete
    await expect(async () => {
      const value = await composer.inputValue();
      expect(value).toContain('![image](.molio/assets/');
      expect(value).toContain('.png)');
    }).toPass({ timeout: 5000 });

    // Upload error indicator should never be visible
    await expect(
      page.locator('[data-testid="composer-upload-error"]'),
    ).not.toBeVisible();
  });

  test('pasting non-image text does not trigger upload', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const composer = page.locator('[data-testid="composer-input"]');
    await expect(composer).toBeVisible();

    // Insert text (synthetic paste events cannot insert text in Chromium
    // due to browser security, so use fill() for the value)
    await composer.fill('Hello, world!');

    // Dispatch a synthetic paste event to verify the handler does not
    // treat text/plain as an image (no upload, no error)
    await composer.evaluate((el) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'Hello, world!');
      el.focus();
      el.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Uploading indicator must not appear for non-image paste
    const uploading = page.locator('[data-testid="composer-uploading"]');
    await expect(uploading).toHaveCount(0);

    // Text value should still be present
    await expect(composer).toHaveValue('Hello, world!');

    // Upload error must not appear either
    await expect(
      page.locator('[data-testid="composer-upload-error"]'),
    ).not.toBeVisible();
  });
});
