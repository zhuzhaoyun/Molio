import { test, expect, type Page } from '@playwright/test';
import { _electron, type ElectronApplication } from '@playwright/test';
import { waitForDaemon, waitForDaemonShutdown } from '../helpers/daemon-health';
import { spawn } from 'node:child_process';

/**
 * Regression test: molio-connect cold-start protocol flow must not kill the daemon.
 *
 * Bug: when molio-connect saved a clip while Molio was closed, it sent
 * `molio://launch` then `molio://open/...`. The second URL spawned a second
 * Molio process. Despite requestSingleInstanceLock() returning false and
 * app.quit() being called, the second process's app.whenReady() still fired
 * and called startDaemonProduction(). The second daemon's
 * checkAndKillPortOccupant() killed the first daemon, then the second process
 * exited taking its daemon too. Result: no daemon → "No vault selected" /
 * empty KB after navigating Home → KB.
 *
 * Fix: guard in app.whenReady() — bail if singleLock is false.
 *
 * Prerequisites: pnpm build && pnpm --filter @molio/desktop package:dir
 * Run: pnpm test:e2e
 */

const EXE_PATH = 'D:\\work\\02-code\\Molio\\apps\\desktop\\dist\\win-unpacked\\Molio.exe';
const VAULT_ID = '55dceff1-2055-4305-8c52-cf2daa421108';
const FILE_PATH = 'Clippings/(2 条消息) 为什么要远离社会底层？ - 知乎.md';
const PROTOCOL_URL = `molio://open/vault/${VAULT_ID}/file/${encodeURIComponent(FILE_PATH).replace(/%2F/g, '/')}`;

let electronApp: ElectronApplication;
let page: Page;

async function clickNav(href: string) {
  // Try data-tooltip first (smoke-test convention), fall back to href match
  const tooltip = ['Home', 'Knowledge Base'].find((t) =>
    href === '/' ? t === 'Home' : t === 'Knowledge Base',
  );
  if (tooltip) {
    try {
      await page.click(`[data-tooltip="${tooltip}"]`, { timeout: 3_000 });
      return;
    } catch { /* fall through */ }
  }
  const link = page.locator(`a.entry-nav-rail__btn[href="${href}"]`);
  await link.click();
}

test.beforeAll(async () => {
  electronApp = await _electron.launch({
    executablePath: EXE_PATH,
    args: ['--disable-gpu', '--no-sandbox', 'molio://launch'],
    env: { ...process.env, MOLIO_DISABLE_UPDATER: '1' },
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForDaemon(3100, 45_000);
  await page.waitForTimeout(6_000);
});

test.afterAll(async () => {
  if (electronApp) {
    try { await electronApp.close(); } catch { /* ignore */ }
    await waitForDaemonShutdown(3100, 10_000);
  }
});

test('cold-start protocol flow: KB opens, survives Home → KB round-trip', async () => {
  // Step 1: spawn second Molio process with molio://open/... (real flow)
  await new Promise<void>((resolve) => {
    const child = spawn(EXE_PATH, ['--disable-gpu', '--no-sandbox', PROTOCOL_URL], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    child.on('exit', () => resolve());
    setTimeout(resolve, 3_000);
  });

  // KB should open via second-instance IPC
  await page.waitForSelector('.kb-file-panel', { state: 'visible', timeout: 15_000 });
  expect(page.url()).toContain('/knowledge');

  // Daemon must still be alive after the second process hit it
  const daemonHealthy = await page.evaluate(async () => {
    try { const r = await fetch('http://localhost:3100/api/health'); return r.ok; }
    catch { return false; }
  });
  expect(daemonHealthy).toBe(true);

  // Step 2: Home → KB round-trip
  await clickNav('/');
  await page.waitForSelector('.home-page', { state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(1_000);

  await clickNav('/knowledge');
  await page.waitForSelector('.kb-file-panel', { state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(3_000);

  // Regression check: vault bar must show a real vault, NOT "No vault selected"
  const vaultBarText = await page.locator('.kb-vault-bar').first().innerText();
  expect(vaultBarText).not.toContain('No vault selected');
  expect(vaultBarText.trim().length).toBeGreaterThan(0);

  // Daemon must STILL be alive after the round-trip
  const daemonHealthyAfter = await page.evaluate(async () => {
    try { const r = await fetch('http://localhost:3100/api/health'); return r.ok; }
    catch { return false; }
  });
  expect(daemonHealthyAfter).toBe(true);
});
