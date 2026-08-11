/**
 * @area knowledge
 * @priority P1
 *
 * Multi-window (P2): URL-driven vault isolation. Each Playwright context is one
 * "window" — contexts share nothing but the daemon + (if same browser context)
 * localStorage. Two separate contexts approximate two Electron windows.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const WEB = 'http://localhost:5173';
const DAEMON_API = 'http://localhost:3100/api';

async function createVault(name: string, vaultPath: string): Promise<string> {
  const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path: vaultPath }),
  });
  expect(res.ok).toBe(true);
  const listRes = await fetch(`${DAEMON_API}/knowledge/vaults`);
  const { vaults } = await listRes.json();
  const v = vaults.find((x: { path: string }) => x.path === vaultPath);
  if (!v) throw new Error(`vault ${name} not found after create`);
  return v.id as string;
}

async function deleteVault(id: string) {
  await fetch(`${DAEMON_API}/knowledge/vaults/${id}`, { method: 'DELETE' }).catch(() => {});
}

test.describe('multi-window vault isolation', () => {
  let vaultAId: string;
  let vaultBId: string;
  let dirA: string;
  let dirB: string;

  test.beforeAll(async () => {
    const ts = Date.now();
    dirA = `/tmp/molio-e2e-mw-a-${ts}`;
    dirB = `/tmp/molio-e2e-mw-b-${ts}`;
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(`${dirA}/alpha.md`, '# Alpha');
    writeFileSync(`${dirA}/beta.md`, '# Beta');
    writeFileSync(`${dirB}/gamma.md`, '# Gamma');
    vaultAId = await createVault('mw-a', dirA);
    vaultBId = await createVault('mw-b', dirB);
  });

  test.afterAll(async () => {
    await deleteVault(vaultAId);
    await deleteVault(vaultBId);
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  test('two windows with different ?vault= show independent vault names', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(`${WEB}/knowledge?vault=${vaultAId}`);
    await pageB.goto(`${WEB}/knowledge?vault=${vaultBId}`);
    await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-a', { timeout: 5000 });
    await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-b', { timeout: 5000 });
    await ctxA.close();
    await ctxB.close();
  });

  test('switching vault in one window reflects ?vault= and does not affect the other', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(`${WEB}/knowledge?vault=${vaultAId}`);
    await pageB.goto(`${WEB}/knowledge?vault=${vaultBId}`);
    await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-a');
    await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-b');

    // Window A switches to vault B via the vault manager modal.
    await pageA.locator('.kb-vault-bar').click();
    await pageA.locator('.vm-vault-item', { hasText: 'mw-b' }).click();
    await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-b');

    // URL in window A now carries the new vault.
    await expect.poll(async () => new URL(pageA.url()).searchParams.get('vault')).toBe(vaultBId);
    // Window B untouched — still its own vault and URL.
    await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-b');
    expect(new URL(pageB.url()).searchParams.get('vault')).toBe(vaultBId);
    await ctxA.close();
    await ctxB.close();
  });

  test('two pages SHARING localStorage (real Electron windows) stay vault-independent via ?vault=', async ({ browser }) => {
    // Electron 多窗口同一 session → 共享 localStorage。真实场景：克隆一个
    // 窗口后两窗同在 vault A，用户把一窗切到 B。要防的是：A 页切 vault 写共享
    // `molio.activeVaultId=B` 后，B 页（模块级 store 已按自己 URL=?vault=A 初始化）
    // 不被串扰弹到 B。一个 context 里两个 page 模拟共享 localStorage。
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    const pageB = await ctx.newPage();
    await pageA.goto(`${WEB}/knowledge?vault=${vaultAId}`);
    await pageB.goto(`${WEB}/knowledge?vault=${vaultAId}`); // 克隆场景：两窗同 vault A
    await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-a');
    await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-a');

    // Page A 切到 vault B → 写共享 localStorage.activeVaultId=B、URL ?vault=B
    await pageA.locator('.kb-vault-bar').click();
    await pageA.locator('.vm-vault-item', { hasText: 'mw-b' }).click();
    await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-b');
    await expect.poll(async () => new URL(pageA.url()).searchParams.get('vault')).toBe(vaultBId);

    // Page B 仍绑定自己的 URL ?vault=A，不被共享 localStorage 的写串扰
    await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-a');
    await ctx.close();
  });

  test('?file= external navigation keeps ?vault= and opens the file', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${WEB}/knowledge?vault=${vaultAId}&file=alpha.md`);
    // File opens (rendered content appears) and the vault is kept in the URL.
    await expect(page.locator('.kb-vault-bar__name')).toHaveText('mw-a', { timeout: 5000 });
    await expect.poll(() => new URL(page.url()).searchParams.get('vault')).toBe(vaultAId);
    // Transient ?file= is dropped from the URL (held in pendingUrlNav state).
    await expect.poll(() => new URL(page.url()).searchParams.get('file')).toBeNull();
    // The file content actually renders in the main area (alpha.md is `# Alpha`).
    await expect(page.locator('.kb-main')).toContainText('Alpha', { timeout: 10_000 });
    await ctx.close();
  });

  test('KB chat does not continue the old vault conversation after switching vault', async ({ browser }) => {
    // Deterministic: mock POST /api/runs so conversationIdRef is populated
    // without a real agent (daemon returns conversationId synchronously on run
    // creation). The SSE subscription to the mock run id hits the real daemon,
    // 404s, and force-unlocks the composer — so the second send creates a fresh
    // POST /api/runs rather than a multi-turn follow-up.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const runs: Array<{ cwd?: string; conversationId?: string }> = [];
    let mockRunCounter = 0;
    await page.route('**/api/runs', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        runs.push({ cwd: body.cwd, conversationId: body.conversationId });
        mockRunCounter += 1;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            runId: `mock-run-${mockRunCounter}`,
            conversationId: `mock-conv-${mockRunCounter}`,
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto(`${WEB}/knowledge?vault=${vaultAId}`);
    await expect(page.locator('.kb-vault-bar__name')).toHaveText('mw-a');
    await page.locator('.kb-tree-item', { hasText: 'alpha.md' }).first().click();
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await input.fill('hello');
    await input.press('Enter');
    await expect.poll(() => runs.length).toBeGreaterThanOrEqual(1);

    // Switch to vault B and send again.
    await page.locator('.kb-vault-bar').click();
    await page.locator('.vm-vault-item', { hasText: 'mw-b' }).click();
    await expect(page.locator('.kb-vault-bar__name')).toHaveText('mw-b');
    await page.locator('.kb-tree-item', { hasText: 'gamma.md' }).first().click();
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const input2 = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await input2.fill('hello again');
    await input2.press('Enter');
    await expect.poll(() => runs.length).toBeGreaterThanOrEqual(2);
    const secondRun = runs[1]!;

    // The second run re-targets the new vault's cwd.
    expect(secondRun.cwd).toContain('molio-e2e-mw-b');
    // And must NOT continue the first run's conversation thread.
    expect(secondRun.conversationId).toBeFalsy();
    await ctx.close();
  });

  test('tabs are scoped per vault across windows', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(`${WEB}/knowledge?vault=${vaultAId}`);
    await pageB.goto(`${WEB}/knowledge?vault=${vaultBId}`);
    await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-a');
    await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-b');

    // Open alpha.md in window A and gamma.md in window B.
    await pageA.locator('.kb-tree-item', { hasText: 'alpha.md' }).first().click();
    await expect(pageA.locator('.kb-wtab', { hasText: 'alpha.md' })).toBeVisible();
    await pageB.locator('.kb-tree-item', { hasText: 'gamma.md' }).first().click();
    await expect(pageB.locator('.kb-wtab', { hasText: 'gamma.md' })).toBeVisible();

    // Each window only sees its own vault's tab.
    await expect(pageA.locator('.kb-wtab', { hasText: 'gamma.md' })).toHaveCount(0);
    await expect(pageB.locator('.kb-wtab', { hasText: 'alpha.md' })).toHaveCount(0);

    // Storage is keyed per vault.
    const keysA = await pageA.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('molio.kb.tabs')));
    const keysB = await pageB.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('molio.kb.tabs')));
    expect(keysA).toContain(`molio.kb.tabs.${vaultAId}`);
    expect(keysB).toContain(`molio.kb.tabs.${vaultBId}`);
    await ctxA.close();
    await ctxB.close();
  });

  test('tab context menu opens the file in a new window', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(`${WEB}/knowledge?vault=${vaultAId}`);
    await expect(page.locator('.kb-vault-bar__name')).toHaveText('mw-a');
    await page.locator('.kb-tree-item', { hasText: 'alpha.md' }).first().click();
    await expect(page.locator('.kb-wtab', { hasText: 'alpha.md' })).toBeVisible();

    // Right-click the tab → 在新窗口打开 (browser fallback = window.open → popup).
    const popupPromise = page.waitForEvent('popup');
    await page.locator('.kb-wtab', { hasText: 'alpha.md' }).click({ button: 'right' });
    await page.locator('[data-testid="tab-open-in-new-window"]').click();

    // Wait for the popup to actually navigate to the knowledge route before
    // reading its URL (a synchronous popup-handler capture can catch about:blank).
    const popup = await popupPromise;
    await popup.waitForURL(/vault=/);
    expect(popup.url()).toContain(`vault=${vaultAId}`);
    expect(popup.url()).toContain('alpha.md');
    await ctx.close();
  });

  test('unified 新建 dropdown offers note, folder, and new-window', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(`${WEB}/knowledge?vault=${vaultAId}`);
    await expect(page.locator('.kb-vault-bar__name')).toHaveText('mw-a');

    await page.locator('[data-testid="kb-btn-create"]').click();
    await expect(page.locator('[data-testid="kb-create-dropdown"]')).toBeVisible();
    await expect(page.locator('[data-testid="kb-create-note"]')).toBeVisible();
    await expect(page.locator('[data-testid="kb-create-folder"]')).toBeVisible();
    await expect(page.locator('[data-testid="kb-create-window"]')).toBeVisible();
    await ctx.close();
  });

  test('新建 → 新窗口 opens a fresh window without forcing a vault', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Start in vault A — the new window must open to the app landing view with
    // NO vault forced; the user picks a vault in the new window via normal nav.
    await page.goto(`${WEB}/knowledge?vault=${vaultAId}`);
    await expect(page.locator('.kb-vault-bar__name')).toHaveText('mw-a');

    const popupPromise = page.waitForEvent('popup');
    await page.locator('[data-testid="kb-btn-create"]').click();
    await page.locator('[data-testid="kb-create-window"]').click();
    const popup = await popupPromise;
    await popup.waitForURL((url) => url.pathname === '/');
    expect(popup.url()).not.toContain('vault=');
    await ctx.close();
  });
});
