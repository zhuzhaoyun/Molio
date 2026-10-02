import { test, expect, type Page } from '@playwright/test';
import { _electron, type ElectronApplication } from '@playwright/test';
import { waitForDaemon, waitForDaemonShutdown } from '../helpers/daemon-health';
import { resolveClipFixture } from '../helpers/kb-fixture';
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
 * Machine-independent: the executable comes from MOLIO_EXE_PATH (resolved by
 * global-setup.ts, same convention as launchMolioApp), and the vault/file
 * target is resolved from the running daemon — first vault + any .md file,
 * creating fixture data only when the machine has none.
 *
 * Prerequisites: pnpm build && pnpm --filter @molio/desktop package:dir
 * Run: pnpm test:e2e
 */

let electronApp: ElectronApplication;
let page: Page;
let exePath: string;
let protocolUrl: string;

async function clickNav(view: 'home' | 'knowledge') {
  await page.click(`[data-view="${view}"]`);
}

test.beforeAll(async () => {
  exePath = process.env.MOLIO_EXE_PATH ?? '';
  if (!exePath) {
    throw new Error(
      '[e2e] MOLIO_EXE_PATH is not set — global-setup.ts should have resolved it. ' +
        'Build first: pnpm build && pnpm --filter @molio/desktop package:dir',
    );
  }

  electronApp = await _electron.launch({
    executablePath: exePath,
    args: ['--disable-gpu', '--no-sandbox', 'molio://launch'],
    env: { ...process.env, MOLIO_DISABLE_UPDATER: '1' },
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForDaemon(3100, 45_000);
  await page.waitForTimeout(6_000);

  // Resolve the open-file target from this machine's daemon (no hardcoded vault).
  const fixture = await resolveClipFixture(3100);
  protocolUrl =
    `molio://open/vault/${fixture.vaultId}/file/` +
    encodeURIComponent(fixture.filePath).replace(/%2F/g, '/');
  console.log(`[e2e] Protocol target: vault="${fixture.vaultName}" file=${fixture.filePath}`);
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
    const child = spawn(exePath, ['--disable-gpu', '--no-sandbox', protocolUrl], {
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
  await clickNav('home');
  await page.waitForSelector('.home-page', { state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(1_000);

  await clickNav('knowledge');
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
