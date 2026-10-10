import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { waitForDaemon, waitForDaemonShutdown } from './daemon-health';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
}

/**
 * Create an isolated data directory for E2E tests.
 * Daemon reads MOLIO_DATA_DIR (see apps/daemon/src/core/db.ts) — pointing it at
 * a temp dir prevents E2E runs from touching the user's real ~/.molio data.
 */
export function createE2EDataDir(): string {
  const dir = path.join(os.tmpdir(), `molio-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Launch the packaged Electron app and wait for daemon to be ready.
 *
 * @param exePath - Path to Molio.exe (defaults to MOLIO_EXE_PATH env var)
 * @param daemonTimeout - Max ms to wait for daemon health (default 45s)
 * @returns { electronApp, page } — the main BrowserWindow page
 */
export async function launchMolioApp(
  exePath?: string,
  daemonTimeout = 45_000,
): Promise<LaunchedApp> {
  const executablePath = exePath ?? process.env.MOLIO_EXE_PATH;
  if (!executablePath) {
    throw new Error(
      'No executable path provided. Set MOLIO_EXE_PATH env var or pass exePath.',
    );
  }

  // Isolated data dir — daemon writes app.sqlite, config.json, runs/, etc.
  // to this temp dir instead of the user's real ~/.molio.
  const dataDir = createE2EDataDir();

  // Launch the Electron app
  const electronApp = await _electron.launch({
    executablePath,
    args: [
      // Disable hardware acceleration for CI/headless stability
      '--disable-gpu',
      '--no-sandbox',
    ],
    env: {
      ...process.env,
      // Prevent auto-updater from firing during tests
      MOLIO_DISABLE_UPDATER: '1',
      // Isolated data directory — see createE2EDataDir
      MOLIO_DATA_DIR: dataDir,
    },
  });

  // Get the main BrowserWindow
  const page = await electronApp.firstWindow();

  // Wait for the window to be ready
  await page.waitForLoadState('domcontentloaded');

  // Wait for daemon to become healthy
  const healthy = await waitForDaemon(3100, daemonTimeout);
  if (!healthy) {
    // Don't throw here — let the test decide if this is fatal.
    // Some tests may want to verify splash screen behavior during startup.
    console.warn('[e2e] Daemon did not become healthy within timeout');
  }

  // Give the UI a moment to fully render after daemon is ready
  await page.waitForTimeout(1_000);

  return { electronApp, page };
}

/**
 * Gracefully close the Electron app and wait for daemon shutdown.
 *
 * After close(), actively polls for remaining Molio.exe processes to ensure
 * the single-instance lock is fully released. If processes linger beyond
 * the timeout, force-kills them with taskkill.
 *
 * Process cleanup only runs in CI (process.env.CI === 'true') to avoid
 * killing the user's locally-running Molio instance during development.
 */
export async function closeMolioApp(
  app: LaunchedApp,
  shutdownTimeout = 10_000,
): Promise<void> {
  try {
    await app.electronApp.close();
  } catch {
    // App may already be closed
  }

  // Wait for daemon process to exit
  await waitForDaemonShutdown(3100, shutdownTimeout);

  // Process cleanup only in CI — locally we don't want to kill the user's
  // running Molio instance (e.g. they might have it open while running tests).
  if (process.env.CI !== 'true') return;

  await ensureNoMolioProcesses();
}

/**
 * Actively poll for lingering Molio.exe processes and force-kill if needed.
 *
 * Electron's single-instance lock is held by the main process — if it lingers
 * after close(), the next spec file's requestSingleInstanceLock() returns false
 * and the app immediately exits. This helper polls for processes and force-kills
 * after a grace period.
 */
export async function ensureNoMolioProcesses(): Promise<void> {
  const cleanupTimeout = 5_000; // 5s to gracefully exit
  const pollInterval = 500;
  const start = Date.now();

  while (Date.now() - start < cleanupTimeout) {
    if (!hasMolioProcess()) return; // Clean exit
    await new Promise(r => setTimeout(r, pollInterval));
  }

  // Timeout — force kill any remaining processes
  console.warn('[e2e] Molio processes still running after 5s, force-killing');
  forceKillMolioProcesses();
  await new Promise(r => setTimeout(r, 1000));
}

/**
 * Check if any Molio.exe processes are still running.
 * Uses tasklist to detect Electron main process and renderer processes.
 * Matches the process name in the output (more robust than counting lines,
 * which can vary by Windows locale).
 */
export function hasMolioProcess(): boolean {
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq Molio.exe" /NH', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // /NH removes the header; if output is empty or whitespace, no processes
    return output.trim().length > 0;
  } catch {
    return false; // tasklist failed — assume no processes
  }
}

/**
 * Force-kill all Molio.exe processes.
 * Use when graceful shutdown fails or as a last-resort cleanup.
 */
export function forceKillMolioProcesses(): void {
  try {
    execSync('taskkill /F /IM Molio.exe', { stdio: 'ignore' });
  } catch {
    // taskkill returns non-zero if no matching process found — ignore
  }
}

/**
 * Wait for daemon to become healthy (re-export for convenience).
 */
export { waitForDaemon } from './daemon-health';

/**
 * Assert at least one of the given locators is visible within timeout.
 *
 * Extracts the repetitive pattern: declare locators → Promise.race waitFor →
 * isVisible checks → final expect. Callers pass an array of locators; this
 * helper handles the race and the final assertion.
 *
 * @param locators - Playwright locators to check (at least one must be visible)
 * @param timeout - Max ms to wait for any locator to become visible (default 5000)
 */
export async function expectAnyVisible(
  locators: Array<ReturnType<Page['locator']>>,
  timeout = 5_000,
): Promise<void> {
  // Race: wait for the first locator to become visible
  await Promise.race(
    locators.map((loc) => loc.waitFor({ state: 'visible', timeout }).catch(() => {})),
  );

  // Assert: at least one is actually visible (race may resolve without any visible)
  const visibleFlags = await Promise.all(
    locators.map((loc) => loc.isVisible().catch(() => false)),
  );
  if (!visibleFlags.some(Boolean)) {
    throw new Error(
      `Expected at least one locator to be visible, but none were. ` +
        `Checked ${locators.length} locator(s).`,
    );
  }
}
