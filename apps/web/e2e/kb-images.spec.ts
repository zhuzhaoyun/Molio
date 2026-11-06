/**
 * @area kb
 * @priority P1
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

let vault: TempVault;
test.beforeAll(async () => {
  vault = await createTempVault('e2e-wiki-images');
  const dir = path.join(vault.path, 'wiki/notes');
  fs.mkdirSync(dir, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(dir, '图 (1).png'), png);
  fs.writeFileSync(path.join(dir, 'note.md'), [
    '# Images',
    '![encoded](%E5%9B%BE%20(1).png)',
    '![title](<图 (1).png> "caption")',
    '![[图 (1).png]]',
    '`![example](local.png)`',
  ].join('\n\n'));
});
test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

test('local images load in read view and typeset preview', async ({ page }) => {
  page.on('pageerror', error => console.error('KB page error:', error.message));
  const vaultsReady = page.waitForResponse(response => response.url().endsWith('/api/knowledge/vaults'));
  await page.goto(`/knowledge?vault=${vault.id}&file=${encodeURIComponent('wiki/notes/note.md')}`);
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 20_000 });
  const list = await (await vaultsReady).json();
  expect(list.vaults.some((item: { id: string }) => item.id === vault.id)).toBe(true);
  await expect(page.locator('.kb-wtab.is-active')).toContainText('note.md', { timeout: 20_000 });
  const images = page.locator('img[src*="/raw/"]:visible');
  await expect(images).toHaveCount(3);
  await expect.poll(() => images.evaluateAll(imgs => imgs.every(img =>
    (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(page.locator('code').filter({ hasText: '![example](local.png)' }).first()).toBeVisible();
  await page.getByTestId('kb-btn-typeset').click();
  await expect(images).toHaveCount(3);
  await expect.poll(() => images.evaluateAll(imgs => imgs.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
});
