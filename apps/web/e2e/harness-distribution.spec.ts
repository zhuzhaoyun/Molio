/**
 * @area kb
 * @priority P1
 */
import { expect, test } from '@playwright/test';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, unzipSync, strToU8 } from 'fflate';

test.skip(process.env.VITE_MOLIO_HARNESS !== '1', 'Harness distribution');

test('host opens the graph directly without Molio chat or runtime discovery', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, '__electron__', { value: {
      openKnowledgeConversation: async (context: object) => { document.body.dataset.conversation = JSON.stringify(context); },
    } });
  });
  const agents: string[] = [];
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/agents') agents.push(req.url()); });
  await page.route('**/api/knowledge/vaults', route => route.fulfill({ json: {
    vaults: [{ id: 'demo', name: 'Demo', path: '/demo' }],
  } }));
  await page.route('**/api/knowledge/vaults/demo/tree', route => route.fulfill({ json: { tree: [] } }));
  await page.route('**/api/graph/demo', route => route.fulfill({ json: { nodes: [], edges: [], deadLinks: [] } }));
  await page.route('**/api/knowledge/vaults/demo/wiki/status', r => r.fulfill({ json: { initialized: true } }));
  await page.goto('/knowledge?panel=graph');
  await expect(page.getByTestId('kb-graph-pane')).toBeVisible();
  for (const [button, mode] of [['kb-btn-ask-tab', 'ask'], ['kb-btn-build-wiki', 'build'], ['kb-btn-lint-wiki', 'lint']]) {
    await page.getByTestId(button).click();
    expect(JSON.parse(await page.locator('body').getAttribute('data-conversation') ?? 'null'))
      .toEqual({ mode, vaultId: 'demo', vaultPath: '/demo' });
  }
  await expect(page.locator('.entry-nav-rail')).toHaveCount(0);
  await page.evaluate(() => {
    window.history.pushState({}, '', '/knowledge?panel=files');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.locator('[data-testid="kb-graph-pane"]:not([inert])')).toHaveCount(0);
  expect(agents).toEqual([]);
});

test('picking a vault dismisses the manager before its tree loads and reuses the last tree on return', async ({ page }) => {
  const rows = ['alpha', 'beta'].map(id => ({ id, name: id, path: '/' + id }));
  let metadataRequested = false;
  await page.route('**/api/knowledge/vaults', route => {
    metadataRequested ||= route.request().headers().prefer === 'return=minimal';
    return route.fulfill({ json: { vaults: rows } });
  });
  await page.route('**/api/knowledge/active-vault', route => route.fulfill({ json: { ok: true } }));
  let delayTree = '';
  let release: (() => void) | undefined;
  let version = 1;
  await page.route('**/api/knowledge/vaults/*/tree', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    if (delayTree === id) await new Promise<void>(resolve => { release = resolve; });
    const path = id + '-' + version + '.md';
    await route.fulfill({ json: { tree: [{ type: 'file', name: path, path }] } });
  });
  const graphs: string[] = [];
  await page.route('**/api/graph/**', route => {
    graphs.push(route.request().url());
    return route.fulfill({ json: { nodes: [], edges: [], deadLinks: [] } });
  });
  await page.goto('/knowledge?vault=alpha');
  const treeFile = (name: string) => page.locator('.kb-tree-item').filter({ hasText: name });
  await expect(treeFile('alpha-1.md')).toBeVisible();
  const pick = async (id: string) => {
    await page.locator('.kb-vault-bar').click();
    const modal = page.getByTestId('vault-manager-modal');
    await modal.locator('.vm-vault-item').filter({ hasText: id }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.kb-vault-bar__name')).toHaveText(id);
  };
  try {
    delayTree = 'beta';
    await pick('beta');
    await expect.poll(() => Boolean(release)).toBe(true);
    release!();
    await expect(treeFile('beta-1.md')).toBeVisible();
    release = undefined;
    delayTree = 'alpha';
    version = 2;
    await pick('alpha');
    await expect(treeFile('alpha-1.md')).toBeVisible();
    await expect.poll(() => Boolean(release)).toBe(true);
    release!();
    await expect(treeFile('alpha-2.md')).toBeVisible();
    await expect(treeFile('alpha-1.md')).toHaveCount(0);
    await pick('alpha');
    expect(metadataRequested).toBe(true);
    expect(graphs).toEqual([]);
  } finally {
    release?.();
  }
});

test('a chat link opens a resolved page before the file watcher updates the tree', async ({ page }) => {
  const path = 'wiki/entities/贾后.md';
  await page.route('**/api/knowledge/vaults', r => r.fulfill({ json: { vaults: [{ id: 'demo', name: 'Demo', path: '/demo' }] } }));
  await page.route('**/api/knowledge/vaults/demo/tree', r => r.fulfill({ json: { tree: [{ type: 'file', name: 'index.md', path: 'index.md' }] } }));
  await page.route('**/demo/resolve/**', r => r.fulfill({ json: { path } }));
  await page.route('**/demo/files/**', r => r.fulfill({ json: { path, content: '# 贾后', encoding: 'utf-8' } }));
  await page.goto('/knowledge?vault=demo&file=' + encodeURIComponent(path));
  await expect(page.locator('.kb-wtab.is-active')).toHaveAttribute('title', path);
});

test('market and account remain reachable from the hosted market', async ({ page }) => {
  await page.route('**/api/market/listings*', route => route.fulfill({ json: { listings: [] } }));
  await page.route('**/api/auth/status', route => route.fulfill({ json: { configured: true, loggedIn: false } }));
  await page.goto('/resources?q=wiki');
  await expect(page.getByTestId('resources-search')).toHaveValue('wiki');
  await page.getByTestId('harness-market-account').click();
  await expect(page.getByTestId('account-email-input')).toBeVisible();
  await page.getByTestId('harness-market-account').click();
  await expect(page.getByTestId('resources-search')).toBeVisible();
  await page.route('**/api/market/listings/demo', route => route.fulfill({ json: {
    id: 'demo', source: 'official', name: 'Demo', summary: 'Demo vault', icon: '📚', tint: 'blue',
    author: 'Demo', version: '1', priceCents: 0, tags: [], overview: [], highlights: [], previews: [], payUrl: '',
  } }));
  await page.goto('/resources/demo');
  await page.getByTestId('resource-buy-demo').click();
  await expect(page.getByTestId('account-email-input')).toBeVisible();
  await page.getByTestId('account-modal-close').click();
  await expect(page.getByTestId('resources-back')).toBeVisible();
});
test('native picker registers Windows folders with their leaf name', async ({ page }) => {
  const folder = 'C:\\Downloads\\研究资料';
  await page.addInitScript(path => {
    Object.defineProperty(window, '__electron__', { value: { showDirectoryPicker: async () => path } });
  }, folder);
  await page.route('**/api/knowledge/vaults', route => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ json: { id: 'demo', ...route.request().postDataJSON() } });
    }
    return route.fulfill({ json: { vaults: [] } });
  });
  await page.goto('/knowledge?manage=1');
  const registered = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/api/knowledge/vaults'));
  await page.getByTestId('vault-open-action').click();
  expect((await registered).postDataJSON()).toMatchObject({ path: folder, name: '研究资料' });
});
test('paid ZIP opens as a local vault and can be submitted by its publisher', async ({ page, context }, testInfo) => {
  const folder = testInfo.outputPath('研究资料');
  await mkdir(folder, { recursive: true });
  await context.addInitScript(path => {
    window.MOLIO_PAY_BASE = location.origin + '/test-pay';
    Object.defineProperty(window, '__electron__', { value: {
      showDirectoryPicker: async () => path,
      openKnowledgeConversation: async (context: object) => { document.body.dataset.conversation = JSON.stringify(context); },
      showItemInFolder: async (file: string) => { document.body.dataset.revealed = file; },
    } });
  }, folder);

  const listing = { id: 'paid', source: 'official', name: '资料包', icon: '📚', tint: 'blue', summary: '资料包',
    author: 'Demo', version: '1', priceCents: 100, tags: [], overview: [], highlights: [], previews: [], payUrl: '' };
  await page.route('**/api/auth/status', r => r.fulfill({ json: { configured: true, loggedIn: true, user: { id: 'tester' } } }));
  await page.route('**/api/market/listings/paid', r => r.fulfill({ json: listing }));
  await page.route('**/test-pay/pay?*', r => r.fulfill({ json: { code_url: 'weixin://fixture', out_trade_no: 'fixture' } }));
  await page.route('**/test-pay/order?*', r => r.fulfill({ json: { status: 'SUCCESS' } }));
  await page.route('**/test-pay/deliver?*', r => r.fulfill({ json: { url: new URL('/fixture.zip', page.url()).href } }));
  await context.route('**/fixture.zip', r => r.fulfill({
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="fixture.zip"' },
    body: Buffer.from(zipSync({ 'Readme.md': strToU8('# 已下载的资料') })),
  }));
  await page.goto('/resources/paid');
  await page.getByTestId('resource-buy-paid').click();
  const link = page.getByTestId('resource-pay-download');
  await expect(link).toBeVisible({ timeout: 12000 });
  const downloaded = page.waitForEvent('download');
  await link.click();
  const zipPath = testInfo.outputPath('fixture.zip');
  await (await downloaded).saveAs(zipPath);
  const contents = unzipSync(await readFile(zipPath));
  await writeFile(join(folder, 'Readme.md'), contents['Readme.md']!);
  await page.getByTestId('resource-pay-close').click();
  await page.route('**/api/market/role', r => r.fulfill({ json: { loggedIn: true, isAdmin: true } }));
  await page.route('**/api/market/my', r => r.fulfill({ json: { listings: [], isAdmin: true } }));
  await page.route('**/api/market/taxonomy', r => r.fulfill({ json: {
    categories: [{ id: 'culture', name: '文化' }], types: [{ id: 'book', name: '书籍' }],
  } }));
  await page.getByTestId('resources-open-kb').click();
  await page.getByTestId('vault-open-action').click();
  const row = page.locator('.vm-vault-item').filter({ hasText: folder });
  await row.getByTestId('vault-more-btn').click();
  await page.getByTestId('vault-menu-reveal').click();
  await expect(page.locator('body')).toHaveAttribute('data-revealed', folder.replaceAll('\\', '/'));
  await row.click();
  await expect(page.getByTestId('vault-manager-close')).toBeHidden();
  await expect(page.locator('.kb-tree-item').filter({ hasText: 'Readme.md' })).toBeVisible();
  const file = page.locator('.kb-tree-item').filter({ hasText: 'Readme.md' });
  await file.hover();
  await file.locator('.wiki-tree-op').click();
  const lastConversation = async () => JSON.parse(await page.locator('body').getAttribute('data-conversation') ?? 'null');
  expect(await lastConversation()).toMatchObject({ mode: 'ingest', filePath: 'Readme.md', vaultPath: folder, isDirectory: false });
  await file.click();
  await page.getByTestId('kb-btn-ask-tab').click();
  expect(await lastConversation()).toMatchObject({ mode: 'ask', filePath: 'Readme.md', vaultPath: folder });
  const heading = page.locator('#output h1').first();
  await heading.evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 480, clientY: 180 }));
  });
  await page.locator('.ctx-menu-item').filter({ hasText: '就此提问' }).click();
  expect(await lastConversation()).toMatchObject({
    mode: 'ask', filePath: 'Readme.md', vaultPath: folder, selectedText: '已下载的资料',
  });
  await page.goto('/resources');
  await page.getByTestId('harness-publish-vault').click();
  const pane = page.getByTestId('kb-publish-pane');
  await expect(pane).toBeVisible();
  await page.getByTestId('publish-category').selectOption('culture');
  await page.getByTestId('publish-type').selectOption('book');
  await pane.locator('input[maxlength="30"]').fill('研究资料');
  await pane.locator('textarea[maxlength="500"]').fill('导入并发布的测试资料。');
  await pane.locator('input[type="file"]').setInputFiles({
    name: 'preview.png', mimeType: 'image/png', buffer: await page.screenshot(),
  });
  await pane.locator('.publish-agreement input').check();
  await page.route('**/api/market/publish', r => r.fulfill({ json: { id: 'fixture' } }));
  const submitted = page.waitForRequest('**/api/market/publish');
  await page.getByTestId('publish-submit-btn').click();
  expect((await submitted).postData()).toContain('name="vaultId"');
  await expect(pane.locator('.publish-done')).toBeVisible();
});
