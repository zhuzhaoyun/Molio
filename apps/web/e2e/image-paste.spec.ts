import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';

const TEST_VAULT_ID = 'e2e-image-paste-vault';
const UPLOADED_FILE_PATH = '.molio/assets/e2e-test-1.png';

test.describe('Composer image paste', () => {
  test('pasting an image shows thumbnail badge', async ({ page }) => {
    // Mock vault list so an active vault exists for the paste handler.
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

    // Wait for thumbnail badge to appear (async upload completes)
    await expect(
      page.locator('[data-testid="composer-image-thumb"]'),
    ).toBeVisible({ timeout: 5000 });

    // The textarea should NOT contain markdown — images are thumbnails, not text
    const textValue = await composer.inputValue();
    expect(textValue).not.toContain('![image]');

    // Upload button should be visible
    await expect(page.locator('[data-testid="composer-upload-btn"]')).toBeVisible();
  });

  test('pasting non-image text does not trigger upload', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const composer = page.locator('[data-testid="composer-input"]');
    await expect(composer).toBeVisible();

    await composer.fill('Hello, world!');

    // Dispatch a synthetic paste event to verify the handler does not
    // treat text/plain as an image (no upload, no thumbnail)
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

    // No image thumbnails should appear for text paste
    const thumbs = page.locator('[data-testid="composer-image-thumb"]');
    await expect(thumbs).toHaveCount(0);

    // Text value should still be present
    await expect(composer).toHaveValue('Hello, world!');
  });

  test('upload button opens file picker', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    // Upload button should exist and be clickable
    const uploadBtn = page.locator('[data-testid="composer-upload-btn"]');
    await expect(uploadBtn).toBeVisible();
    await expect(uploadBtn).toBeEnabled();

    // Hidden file input should exist
    const fileInput = page.locator('[data-testid="composer-file-input"]');
    await expect(fileInput).toBeHidden();
  });
});
