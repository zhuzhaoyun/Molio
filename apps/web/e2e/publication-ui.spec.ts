/** @area public-wiki
 * @priority P1
 * Exercises per-page admin selection and the isolated anonymous Wiki/graph shell.
 */
import { test, expect } from './fixtures/admin-server';
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

test.use({ ignoreHTTPSErrors: true });

test('published snapshots remain individually and batch withdrawable after source deletion or rename', async ({ page, admin }) => {
  const wiki = join(admin.vaultDir, 'wiki'); mkdirSync(wiki, { recursive: true });
  writeFileSync(join(wiki, 'deleted.md'), '# Deleted source snapshot');
  writeFileSync(join(wiki, 'renamed.md'), '# Renamed source snapshot');
  await page.goto(`${admin.origin}/knowledge`);
  await page.getByTestId('admin-username-input').fill(admin.username);
  await page.getByTestId('admin-password-input').fill(admin.password);
  await page.getByTestId('admin-login-submit').click();
  await page.getByTestId('kb-btn-public-wiki').click();
  await page.getByTestId('publication-select-all').click();
  await page.getByTestId('publication-batch-publish').click(); await page.getByTestId('publication-commit').click();
  const rows = page.getByTestId('publication-page-row');
  await expect(rows.filter({ hasText: 'deleted.md' })).toHaveAttribute('data-published', 'true');
  await page.getByTestId('publication-site-enabled').click();
  await expect(page.getByTestId('publication-site-enabled')).toBeChecked();
  rmSync(join(wiki, 'deleted.md')); renameSync(join(wiki, 'renamed.md'), join(wiki, 'new-name.md'));
  // A cold tree scan makes this independent of the external-file watcher delay.
  await admin.restart();
  await page.reload(); await page.getByTestId('kb-btn-public-wiki').click();
  const deleted = rows.filter({ hasText: 'deleted.md' }); const renamed = rows.filter({ hasText: 'renamed.md' });
  await expect(deleted).toBeVisible(); await expect(renamed).toBeVisible();
  await expect(rows.filter({ hasText: 'new-name.md' })).toHaveAttribute('data-published', 'false');
  await deleted.getByRole('checkbox').check();
  await expect(page.getByTestId('publication-batch-publish')).toBeDisabled();
  await expect(page.getByTestId('publication-batch-withdraw')).toBeEnabled();
  page.once('dialog', dialog => dialog.accept()); await deleted.getByRole('button').click();
  await expect(deleted).toHaveCount(0);
  await page.getByTestId('publication-select-all').click();
  page.once('dialog', dialog => dialog.accept()); await page.getByTestId('publication-batch-withdraw').click();
  await expect(renamed).toHaveCount(0);
  const site = await (await page.request.get(`${admin.origin}/api/public/site`)).json() as { pages: unknown[] };
  expect(site.pages).toEqual([]);
});

test('administrator publishes selected Wiki pages and anonymous visitor navigates the snapshot', async ({ page, browser, admin }) => {
  const wiki = join(admin.vaultDir, 'wiki');
  mkdirSync(wiki, { recursive: true });
  writeFileSync(join(wiki, 'public-a.md'), '# Public A\n\nLinks to [[Public B]] and [[Private C]].\n\n![Missing image](missing-image.png)\n\n<script>window.__publicLeak = true</script>\n<img src="/api/knowledge/private-marker">\n');
  writeFileSync(join(wiki, 'public-b.md'), '# Public B\n');
  writeFileSync(join(wiki, 'private-c.md'), '# Private C\n');

  await page.goto(`${admin.origin}/knowledge`);
  await page.locator('[data-testid="admin-username-input"]').fill(admin.username);
  await page.locator('[data-testid="admin-password-input"]').fill(admin.password);
  await page.locator('[data-testid="admin-login-submit"]').click();
  await expect(page.locator('.entry-shell')).toBeVisible();

  await page.getByTestId('nav-public-wiki').click();
  await expect(page).toHaveURL(/\/public\/wiki$/);
  await expect(page.locator('.public-header')).toBeVisible();
  await page.goto(`${admin.origin}/knowledge`);
  await page.getByTestId('kb-btn-public-wiki').click();
  await expect(page.getByTestId('public-publication-panel')).toBeVisible();

  const a = page.getByTestId('publication-page-row').filter({ hasText: 'public-a.md' });
  const b = page.getByTestId('publication-page-row').filter({ hasText: 'public-b.md' });
  const c = page.getByTestId('publication-page-row').filter({ hasText: 'private-c.md' });
  await expect(a).toBeVisible();
  await expect(c).toBeVisible();
  await expect(page.getByTestId('publication-page-row').filter({ hasText: 'acceptance.md' })).toHaveCount(0);

  const selectAll = page.getByTestId('publication-select-all');
  await selectAll.click();
  await expect(a.getByRole('checkbox')).toBeChecked();
  await expect(b.getByRole('checkbox')).toBeChecked();
  await expect(c.getByRole('checkbox')).toBeChecked();
  await selectAll.click();
  await expect(a.getByRole('checkbox')).not.toBeChecked();
  await expect(b.getByRole('checkbox')).not.toBeChecked();
  await expect(c.getByRole('checkbox')).not.toBeChecked();

  await a.getByRole('checkbox').check();
  await b.getByRole('checkbox').check();
  await page.getByTestId('publication-batch-publish').click();
  await expect(page.getByTestId('publication-preview-revision')).toContainText('版本 0');
  await expect(page.getByTestId('publication-preview-page-count')).toContainText('2');
  await expect(page.getByTestId('publication-preview-content')).toContainText('Public A');
  await expect(page.getByTestId('publication-preview-content')).toContainText('Public B');
  await expect(page.getByTestId('publication-preview-content')).not.toContainText('Private C');
  await page.getByTestId('publication-commit').click();
  await expect(page.getByTestId('publication-page-row').filter({ hasText: 'public-a.md' })).toContainText('已发布');
  await expect(page.getByTestId('publication-page-row').filter({ hasText: 'public-b.md' })).toContainText('已发布');
  await a.getByRole('checkbox').check();
  await page.getByTestId('publication-batch-publish').click();
  await expect(page.getByTestId('publication-preview-revision')).toContainText('版本 1');
  await page.getByTestId('publication-commit').click();
  await page.getByTestId('publication-site-enabled').click();
  await expect(page.getByTestId('publication-site-enabled')).toBeChecked();

  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  const visitor = await anonymous.newPage();
  await visitor.setViewportSize({ width: 360, height: 740 });
  const publicRequests: string[] = [];
  visitor.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === admin.origin && url.pathname.startsWith('/api/')) publicRequests.push(url.pathname);
  });
  try {
    const aId = await a.getAttribute('data-page-id');
    expect(aId).toBeTruthy();
    await visitor.goto(`${admin.origin}/public/wiki/${aId}`);
    await expect(visitor.getByTestId('public-wiki-page')).toContainText('Public A');
    await expect(visitor.getByTestId('public-wiki-page')).not.toContainText('Private C');
    expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await visitor.evaluate(() => (window as Window & { __publicLeak?: boolean }).__publicLeak)).toBeUndefined();
    await expect(visitor.locator('.public-markdown img')).toHaveCount(0);
    await expect(visitor.getByTestId('public-wiki-page')).toContainText('图片暂不可用');
    await expect(visitor.getByTestId('public-wiki-page')).not.toContainText('molio-image-unavailable');
    const bId = await page.locator('[data-testid="publication-page-row"]').filter({ hasText: 'public-b.md' }).getAttribute('data-page-id');
    expect(bId).toBeTruthy();
    let releaseSecondRead!: () => void;
    const secondReadReleased = new Promise<void>((resolve) => { releaseSecondRead = resolve; });
    let bReads = 0;
    await visitor.route(`**/api/public/pages/${bId}?revision=*`, async (route) => {
      bReads += 1;
      if (bReads === 1) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
      const response = await route.fetch();
      await secondReadReleased;
      await route.fulfill({ response });
    });
    await visitor.getByTestId('public-wiki-page').getByRole('link', { name: 'Public B' }).click();
    await expect(visitor.getByTestId('public-wiki-page')).toHaveCount(0);
    await expect(visitor.getByRole('status')).toBeVisible();
    releaseSecondRead();
    await expect(visitor.getByTestId('public-wiki-page')).toContainText('Public B');
    await visitor.getByRole('link', { name: '图谱' }).click();
    await expect(visitor.getByTestId('public-graph')).toBeVisible();
    const publicGraph = visitor.getByTestId('public-graph-canvas');
    await expect(publicGraph).toBeVisible();
    await expect(publicGraph).toHaveAttribute('data-node-count', '2');
    await expect.poll(async () => Number(await publicGraph.getAttribute('data-zoom-scale'))).toBeGreaterThan(0);
    const minimap = publicGraph.getByTestId('graph-minimap');
    await expect(minimap).toHaveCSS('position', 'absolute');
    await expect(minimap).toHaveCSS('width', '160px');
    const minimapBox = await minimap.boundingBox();
    const viewportBox = await publicGraph.boundingBox();
    expect(minimapBox).toBeTruthy();
    expect(viewportBox).toBeTruthy();
    expect(minimapBox!.y + minimapBox!.height).toBeLessThanOrEqual(viewportBox!.y + viewportBox!.height);
    const initialZoom = Number(await publicGraph.getAttribute('data-zoom-scale'));
    await visitor.getByTestId('public-graph-zoom-out').click();
    await expect.poll(async () => Number(await publicGraph.getAttribute('data-zoom-scale'))).toBeLessThan(initialZoom);
    const zoomAfterButton = Number(await publicGraph.getAttribute('data-zoom-scale'));
    await visitor.getByTestId('public-graph-zoom-in').click();
    await expect.poll(async () => Number(await publicGraph.getAttribute('data-zoom-scale'))).toBeGreaterThan(zoomAfterButton);
    const zoomAfterIn = Number(await publicGraph.getAttribute('data-zoom-scale'));
    const canvasBox = await publicGraph.locator('canvas[role="img"]').boundingBox();
    expect(canvasBox).toBeTruthy();
    await visitor.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2);
    await visitor.mouse.wheel(0, 160);
    await expect.poll(async () => Number(await publicGraph.getAttribute('data-zoom-scale'))).toBeLessThan(zoomAfterIn);
    await visitor.getByTestId('public-graph-fit').click();
    await visitor.getByTestId(`public-graph-page-${aId}`).click();
    await expect(visitor.getByTestId('public-wiki-page')).toContainText('Public A');
    await visitor.getByRole('link', { name: '图谱' }).click();
    await visitor.reload();
    await expect(visitor.getByTestId('public-graph')).toBeVisible();
    expect(publicRequests.length).toBeGreaterThan(0);
    expect(publicRequests.every((url) => url.startsWith('/api/public/'))).toBe(true);
  } finally { await anonymous.close(); }

  await a.getByRole('checkbox').check();
  await b.getByRole('checkbox').check();
  const withdrawnPageId = await a.getAttribute('data-page-id');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('publication-batch-withdraw').click();
  await expect(a).toContainText('未发布');
  await expect(b).toContainText('未发布');
  const withdrawnVisitor = await browser.newPage({ ignoreHTTPSErrors: true });
  try {
    await withdrawnVisitor.goto(`${admin.origin}/public/wiki/${withdrawnPageId}`);
    await expect(withdrawnVisitor.getByRole('alert')).toBeVisible();
  } finally { await withdrawnVisitor.close(); }
});
