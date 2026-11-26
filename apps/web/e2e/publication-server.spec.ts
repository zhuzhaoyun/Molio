/** @area public-wiki
 * @priority P1
 * Verifies anonymous response headers and withdrawal behavior through isolated HTTPS.
 */
import { test, expect } from './fixtures/admin-server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test.use({ ignoreHTTPSErrors: true });

test('HTTPS visitor reads only the active revision and withdrawn content becomes unavailable', async ({ page, browser, admin }) => {
  const wiki = join(admin.vaultDir, 'wiki');
  mkdirSync(wiki, { recursive: true });
  writeFileSync(join(wiki, 'acceptance-public.md'), '# HTTPS public marker\n\nPrivate marker stays outside the Wiki.\n');
  writeFileSync(join(admin.vaultDir, 'private-marker.md'), '# HTTPS private marker\n');

  await page.goto(`${admin.origin}/knowledge`);
  await page.locator('[data-testid="admin-username-input"]').fill(admin.username);
  await page.locator('[data-testid="admin-password-input"]').fill(admin.password);
  await page.locator('[data-testid="admin-login-submit"]').click();
  await expect(page.locator('.entry-shell')).toBeVisible();
  await page.getByTestId('kb-btn-public-wiki').click();
  await page.getByTestId('publication-page-row').filter({ hasText: 'acceptance-public.md' }).getByRole('checkbox').check();
  await page.getByTestId('publication-batch-publish').click();
  await page.getByTestId('publication-commit').click();
  const row = page.getByTestId('publication-page-row').filter({ hasText: 'acceptance-public.md' });
  await expect(row).toContainText('已发布');
  const id = await row.getByRole('button', { name: '撤回' }).getAttribute('data-page-id');
  await page.getByTestId('publication-site-enabled').click();
  await expect(page.getByTestId('publication-site-enabled')).toBeChecked();

  const visitor = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const siteResponse = await visitor.request.get(`${admin.origin}/api/public/site`);
    expect(siteResponse.ok()).toBe(true);
    expect(siteResponse.headers()['cache-control']).toContain('no-store');
    expect(siteResponse.headers()['x-content-type-options']).toBe('nosniff');
    const site = await siteResponse.json() as { revision: number; pages: Array<{ id: string; title: string }> };
    expect(JSON.stringify(site)).not.toContain(admin.vaultDir);
    expect(JSON.stringify(site)).not.toContain('sourcePath');
    expect(JSON.stringify(site)).not.toContain('private-marker.md');
    const current = await visitor.request.get(`${admin.origin}/api/public/pages/${id}?revision=${site.revision}`);
    expect(current.ok()).toBe(true);
    expect(await current.text()).toContain('HTTPS public marker');

    page.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: '撤回' }).click();
    const stale = await visitor.request.get(`${admin.origin}/api/public/pages/${id}?revision=${site.revision}`);
    expect(stale.status()).toBe(404);
    expect(await stale.text()).toBe('{"error":"unavailable"}');
    const updatedSite = await (await visitor.request.get(`${admin.origin}/api/public/site`)).json() as { pages: Array<{ title: string }> };
    expect(JSON.stringify(updatedSite)).not.toContain('HTTPS public marker');
    expect(JSON.stringify(updatedSite)).not.toContain('private-marker.md');
  } finally { await visitor.close(); }
});
