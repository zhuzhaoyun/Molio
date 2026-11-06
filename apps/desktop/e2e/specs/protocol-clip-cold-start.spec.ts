import { test, expect, type Page } from '@playwright/test';
import { _electron, type ElectronApplication } from '@playwright/test';
import { waitForDaemon, waitForDaemonShutdown } from '../helpers/daemon-health';
import { resolveClipFixture } from '../helpers/kb-fixture';
import { ensureNoMolioProcesses, createE2EDataDir, pickDaemonPort, gotoChatSpa } from '../helpers/electron-app';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

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
let daemonPort: number;
let dataDir: string;

async function clickNav(view: 'knowledge') {
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

  dataDir = createE2EDataDir();
  daemonPort = await pickDaemonPort();
  electronApp = await _electron.launch({
    executablePath: exePath,
    args: ['--disable-gpu', '--no-sandbox', 'molio://launch', `--user-data-dir=${dataDir}`],
    env: {
      ...process.env,
      MOLIO_DISABLE_UPDATER: '1',
      // Isolated data dir — daemon writes app.sqlite, config.json, runs/, etc.
      // to this temp dir instead of the user's real ~/.molio.
      MOLIO_DATA_DIR: dataDir,
      // Ephemeral port outside CI so the installed app can stay running.
      MOLIO_PORT: String(daemonPort),
      // Runtime homes + debug logs follow the daemon's env hooks (data-dir.ts),
      // same isolation set the web E2E injects.
      MOLIO_CLAUDE_HOME: path.join(dataDir, 'claude'),
      MOLIO_CODEX_HOME: path.join(dataDir, 'codex'),
      MOLIO_DEBUG_LOG_DIR: path.join(dataDir, 'debug'),
    },
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForDaemon(daemonPort, 45_000);
  await page.waitForTimeout(6_000);

  // Resolve the open-file target from this machine's daemon (no hardcoded vault).
  const fixture = await resolveClipFixture(daemonPort);
  protocolUrl =
    `molio://open/vault/${fixture.vaultId}/file/` +
    encodeURIComponent(fixture.filePath).replace(/%2F/g, '/');
  console.log(`[e2e] Protocol target: vault="${fixture.vaultName}" file=${fixture.filePath}`);
});

test.afterAll(async () => {
  if (electronApp) {
    try { await electronApp.close(); } catch { /* ignore */ }
  }

  // Wait for daemon shutdown
  await waitForDaemonShutdown(daemonPort, 10_000);

  // Process cleanup only in CI — locally we don't want to kill the user's
  // running Molio instance (e.g. they might have it open while running tests).
  if (process.env.CI === 'true') {
    await ensureNoMolioProcesses();
  }
});

test('cold-start protocol flow: KB opens, survives Home → KB round-trip', async () => {
  // Step 1: spawn second Molio process with molio://open/... (real flow)
  await new Promise<void>((resolve) => {
    // The second process must share the test instance's userData + daemon port:
    // with the default userData it would target the user's installed Molio
    // (single-instance lock) instead of handing the URL to our test window.
    const child = spawn(
      exePath,
      ['--disable-gpu', '--no-sandbox', `--user-data-dir=${dataDir}`, protocolUrl],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, MOLIO_PORT: String(daemonPort), MOLIO_DATA_DIR: dataDir },
      },
    );
    child.unref();
    child.on('exit', () => resolve());
    setTimeout(resolve, 3_000);
  });

  // KB should open via second-instance IPC
  await page.waitForSelector('.kb-file-panel', { state: 'visible', timeout: 15_000 });
  expect(page.url()).toContain('/knowledge');

  // Daemon must still be alive after the second process hit it
  const daemonHealthy = await page.evaluate(async (port) => {
    try { const r = await fetch(`http://localhost:${port}/api/health`); return r.ok; }
    catch { return false; }
  }, daemonPort);
  expect(daemonHealthy).toBe(true);

  // Step 2: /chat → KB round-trip (the regression is about leaving KB and
  // coming back — the chat page is now /chat, off the nav rail since #293)
  await gotoChatSpa(page);
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
  const daemonHealthyAfter = await page.evaluate(async (port) => {
    try { const r = await fetch(`http://localhost:${port}/api/health`); return r.ok; }
    catch { return false; }
  }, daemonPort);
  expect(daemonHealthyAfter).toBe(true);
});
